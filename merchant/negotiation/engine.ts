import "server-only";
import { createHash } from "node:crypto";
import { moneySchema, quoteSchema, type Money, type Quote } from "../../shared/merchant-contracts";
import { merchantRFQEnvelopeSchema, type MerchantRFQEnvelope } from "../a2a/contracts";
import { calculateMerchantRFQ } from "../a2a/engine";
import { settingsSchema } from "../private-contracts";
import { validateHumanQuote, type HumanQuoteData } from "../telegram/validation";
import type { QuoteDraft } from "../telegram/contracts";
import { negotiationPriceSchema, negotiationServiceWindowSchema, type NegotiationCode, type NegotiationServiceWindow } from "./contracts";

export type NegotiationOptions = { serviceWindow?: NegotiationServiceWindow; expiresAt?: string };
export type NegotiatedQuote = { quote: Quote; outcome: "accepted" | "countered"; serviceWindow?: NegotiationServiceWindow };
const messages: Record<NegotiationCode, string> = {
  stale_quote: "Үнийн саналын хувилбар хуучирсан байна. Шинэ саналыг авна уу.",
  quote_expired: "Үнийн саналын хүчинтэй хугацаа дууссан байна.",
  rfq_expired: "Үнийн саналын хүсэлтийн хүчинтэй хугацаа дууссан байна.",
  negotiation_disabled: "Худалдаачин үнэ тохиролцох хүсэлт одоогоор хүлээн авахгүй байна.",
  round_limit: "Үнэ тохиролцох оролдлогын зөвшөөрсөн тоонд хүрсэн байна.",
  negotiation_pending: "Үнэ тохиролцох хүсэлт шийдвэр хүлээж байна.",
  price_rejected: "Санал болгосон үнийг энэ үнийн саналын нөхцөлөөр баталгаажуулах боломжгүй байна.",
  merchant_rejected: "Худалдаачин үнийн саналыг баталгаажуулах боломжгүй байна.",
  merchant_timeout: "Үнэ тохиролцох хүсэлтийн хариу өгөх хугацаа дууссан байна.",
  availability_changed: "Сэлбэг эсвэл засварын цагийн боломж өөрчлөгдсөн байна. Шинэ үнийн санал хүснэ үү.",
  invalid_price: "Үнийг бүхэл төгрөгөөр, эерэг дүнгээр бичнэ үү.",
};
export class NegotiationRuleError extends Error {
  constructor(readonly kind: NegotiationCode) { super(messages[kind]); this.name = "NegotiationRuleError"; }
}
function fail(kind: NegotiationCode): never { throw new NegotiationRuleError(kind); }
const ceilWholeMNT = (minor: bigint): bigint => (minor + BigInt(99)) / BigInt(100);
const discounted = (minor: number, discountBps: number): bigint =>
  (BigInt(minor) * BigInt(10000 - discountBps) + BigInt(9999)) / BigInt(10000);

/** Pricing changes only existing quote unit prices; no stock, resources or appointments are reserved. */
export function priceNegotiatedQuote(data: HumanQuoteData, originalInput: Quote, envelopeInput: MerchantRFQEnvelope,
  requestedInput: Money, now: Date, revision: number, options: NegotiationOptions = {}): NegotiatedQuote {
  const originalResult = quoteSchema.safeParse(originalInput), envelopeResult = merchantRFQEnvelopeSchema.safeParse(envelopeInput), requestedResult = negotiationPriceSchema.safeParse(requestedInput);
  if (!requestedResult.success) fail("invalid_price");
  if (!originalResult.success || !envelopeResult.success || !Number.isFinite(now.getTime())) fail("availability_changed");
  const original = originalResult.data, envelope = envelopeResult.data, requested = requestedResult.data, rfq = envelope.rfq;
  if (original.merchantId !== rfq.merchantId || original.rfqId !== rfq.id || original.buyerId !== rfq.buyerId || original.kind !== rfq.kind ||
      original.mode !== "simulated" || !Number.isSafeInteger(revision) || revision <= original.revision || original.status !== "offered") fail("stale_quote");
  if (Date.parse(original.expiresAt) <= now.getTime()) fail("quote_expired");
  if (Date.parse(envelope.expiresAt) <= now.getTime() || (rfq.requiredBy && Date.parse(rfq.requiredBy) <= now.getTime())) fail("rfq_expired");
  if (options.expiresAt && (!Number.isFinite(Date.parse(options.expiresAt)) || Date.parse(options.expiresAt) <= now.getTime())) fail("merchant_timeout");
  if (original.total.currency !== "MNT" || original.total.amountMinor % 100 || original.lines.some(line => line.unitPrice.currency !== "MNT" || line.unitPrice.amountMinor % 100)) fail("invalid_price");
  if (requested.amountMinor > original.total.amountMinor) fail("price_rejected");
  const settingsResult = settingsSchema.safeParse(data.settings);
  if (!settingsResult.success || !settingsResult.data.negotiationEnabled || settingsResult.data.merchantId !== rfq.merchantId) fail("negotiation_disabled");
  const settings = settingsResult.data;
  if (!data.profile?.active || data.profile.id !== rfq.merchantId || data.profile.merchantId !== rfq.merchantId || data.profile.mode !== original.mode) fail("merchant_rejected");
  if ([...data.inventory, ...data.services, ...data.slots].some(record => record.merchantId !== rfq.merchantId)) fail("availability_changed");
  const resources = rfq.kind === "parts" ? data.inventory : data.services;
  let window: NegotiationServiceWindow | undefined;
  let slotId: string | null = null;
  if (rfq.kind === "repair") {
    const parsedWindow = negotiationServiceWindowSchema.safeParse(options.serviceWindow);
    if (!parsedWindow.success) fail("availability_changed");
    const slot = data.slots.find(candidate => Date.parse(candidate.startsAt) === Date.parse(parsedWindow.data.startsAt) &&
      Date.parse(candidate.endsAt) === Date.parse(parsedWindow.data.endsAt) && candidate.merchantId === rfq.merchantId && candidate.status === "available" &&
      candidate.capacity > 0 && Date.parse(candidate.startsAt) > now.getTime());
    if (!slot) fail("availability_changed");
    window = parsedWindow.data; slotId = slot.id;
  }
  const draft: QuoteDraft = { lines: [], slotId }, remainingItems = rfq.items.map(item => item.quantity);
  const draftOriginalIndexes: number[] = [];
  const allocations: { originalIndex: number; price: bigint; floor: bigint; quantity: bigint }[] = [];
  try {
    for (const [originalIndex, line] of original.lines.entries()) {
      const resource = resources.find(candidate => candidate.id === line.resourceId && candidate.active && candidate.merchantId === rfq.merchantId);
      if (!resource || resource.price.currency !== "MNT" || resource.minimumPrice.currency !== "MNT") fail("availability_changed");
      const minimum = BigInt(resource.minimumPrice.amountMinor), storedFloor = discounted(resource.price.amountMinor, settings.maxDiscountBps),
        quotedFloor = discounted(line.unitPrice.amountMinor, settings.maxDiscountBps);
      const floor = ceilWholeMNT([minimum, storedFloor, quotedFloor].reduce((max, current) => current > max ? current : max));
      const price = BigInt(line.unitPrice.amountMinor / 100);
      if (floor > price) fail("price_rejected");
      allocations.push({ originalIndex, price, floor, quantity: BigInt(line.quantity) });
      // Public Quote v1 carries no RFQ item index. Match only its unchanged resource
      // using the established capability/fitment logic, splitting quantities across
      // repeated RFQ items for validation without changing published quote lines.
      let needed = line.quantity;
      for (const [itemIndex, item] of rfq.items.entries()) {
        if (!needed || !remainingItems[itemIndex]) continue;
        const quantity = Math.min(needed, remainingItems[itemIndex]);
        const selected = { ...data, inventory: "stock" in resource ? [resource] : [], services: "durationMinutes" in resource ? [resource] : [],
          slots: slotId ? data.slots.filter(slot => slot.id === slotId) : data.slots };
        const match = calculateMerchantRFQ(rfq.merchantId, { ...envelope, rfq: { ...rfq, items: [{ ...item, quantity }] } }, selected, now);
        if (!match.quote?.lines.some(candidate => candidate.resourceId === resource.id && candidate.quantity === quantity)) continue;
        draft.lines.push({ itemIndex, resourceId: resource.id, quantity, unitPrice: line.unitPrice,
          condition: "condition" in resource ? resource.condition : null, available: true, warranty: null });
        draftOriginalIndexes.push(originalIndex);
        remainingItems[itemIndex] -= quantity; needed -= quantity;
      }
      if (needed) fail("availability_changed");
    }
    const target = BigInt(requested.amountMinor / 100), originalTotal = BigInt(original.total.amountMinor / 100),
      minimumTotal = allocations.reduce((sum, line) => sum + line.floor * line.quantity, BigInt(0));
    const targetTotal = target > minimumTotal ? target : minimumTotal;
    let reduction = originalTotal - targetTotal;
    // Stable order prioritizes the highest unit prices. Each chosen unit price is
    // integral MNT, so quantities can leave a residual that requires a counteroffer.
    for (const allocation of [...allocations].sort((a, b) => a.price === b.price ? a.originalIndex - b.originalIndex : a.price > b.price ? -1 : 1)) {
      const possible = allocation.price - allocation.floor;
      const desired = reduction / allocation.quantity;
      const applied = possible < desired ? possible : desired;
      allocation.price -= applied; reduction -= applied * allocation.quantity;
    }
    const lines = original.lines.map((line, index) => ({ ...line, unitPrice: moneySchema.parse({ amountMinor: Number(allocations[index].price * BigInt(100)), currency: "MNT" }) }));
    // Reuse the complete Phase 4 validation for scope, public capability, aggregate
    // stock, warranty and repair duration. Split validation draft lines may refer
    // to the same original quote resource; their aggregate is still checked.
    for (const [index, line] of draft.lines.entries()) line.unitPrice = lines[draftOriginalIndexes[index]].unitPrice;
    validateHumanQuote({ ...data, settings }, envelope, draft, now, revision);
    const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice.amountMinor, 0), createdAt = now.toISOString();
    const quote = quoteSchema.parse({ ...original, id: `nq-${createHash("sha256").update(`${rfq.merchantId}:${rfq.id}:${revision}`).digest("hex").slice(0, 48)}`,
      revision, createdAt, availabilityCheckedAt: createdAt, lines, total: { amountMinor: total, currency: "MNT" },
      expiresAt: new Date(Math.min(Date.parse(original.expiresAt), Date.parse(envelope.expiresAt), now.getTime() + 15 * 60000,
        options.expiresAt ? Date.parse(options.expiresAt) : Infinity, window ? Date.parse(window.startsAt) : Infinity,
        rfq.requiredBy ? Date.parse(rfq.requiredBy) : Infinity)).toISOString(), status: "offered", reservation: false,
    });
    return { quote, outcome: total === requested.amountMinor ? "accepted" : "countered", ...(window ? { serviceWindow: window } : {}) };
  } catch (error) {
    if (error instanceof NegotiationRuleError) throw error;
    fail("availability_changed");
  }
}

/** Human approval may accept only exactly representable prices; never silently raise a human-entered target. */
export function validateHumanNegotiationPrice(data: HumanQuoteData, original: Quote, envelope: MerchantRFQEnvelope,
  requestedTotal: Money, now: Date, revision: number, options: NegotiationOptions = {}): NegotiatedQuote {
  const result = priceNegotiatedQuote(data, original, envelope, requestedTotal, now, revision, options);
  if (result.outcome !== "accepted") fail("price_rejected");
  return result;
}
