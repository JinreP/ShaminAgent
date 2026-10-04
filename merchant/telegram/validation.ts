import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { quoteSchema, type Quote } from "../../shared/merchant-contracts";
import { merchantRFQEnvelopeSchema, type MerchantRFQEnvelope } from "../a2a/contracts";
import { calculateMerchantRFQ } from "../a2a/engine";
import type { MerchantRFQData } from "../a2a/store";
import { inventorySchema, serviceSchema, settingsSchema, slotSchema } from "../private-contracts";
import { quoteDraftSchema, type QuoteDraft } from "./contracts";
import { missingDraftFields } from "./extraction";

export type HumanQuoteData = MerchantRFQData & { settings?: z.infer<typeof settingsSchema> | null };
export type HumanRFQData = HumanQuoteData;
export class HumanQuoteError extends Error {
  constructor(message: string, readonly kind: "incomplete" | "invalid" = "invalid") {
    super(message);
    this.name = "HumanQuoteError";
  }
}
const invalid = () => new HumanQuoteError("Үнийн санал худалдаачны үнэ, бараа эсвэл үйлчилгээний нөхцөлд нийцэхгүй байна. Мэдээллээ шалгаад засна уу.");

function withinPriceRules(price: number, resource: HumanQuoteData["inventory"][number] | HumanQuoteData["services"][number], settings: HumanQuoteData["settings"]): boolean {
  if (resource.price.currency !== "MNT" || resource.minimumPrice.currency !== "MNT") return false;
  // Integer arithmetic preserves the exact floor, including values near MAX_SAFE_INTEGER.
  const discountFloor = settings?.negotiationEnabled ?
    (BigInt(resource.price.amountMinor) * BigInt(10000 - settings.maxDiscountBps) + BigInt(9999)) / BigInt(10000) : BigInt(resource.price.amountMinor);
  const minimum = BigInt(resource.minimumPrice.amountMinor);
  return BigInt(price) >= (minimum > discountFloor ? minimum : discountFloor);
}

/** Called inside the publication transaction with freshly loaded scoped records. It never reserves anything. */
export function validateHumanQuote(input: HumanQuoteData, inputEnvelope: MerchantRFQEnvelope, inputDraft: QuoteDraft, now: Date, revision: number): Quote {
  const envelopeResult = merchantRFQEnvelopeSchema.safeParse(inputEnvelope), draftResult = quoteDraftSchema.safeParse(inputDraft);
  if (!envelopeResult.success || !draftResult.success || !Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(now.getTime())) throw invalid();
  const envelope = envelopeResult.data, draft = draftResult.data, rfq = envelope.rfq, merchantId = rfq.merchantId;
  if (Date.parse(envelope.expiresAt) <= now.getTime() || (rfq.requiredBy && Date.parse(rfq.requiredBy) <= now.getTime()))
    throw new HumanQuoteError("Хүсэлтийн хүчинтэй хугацаа дууссан тул үнийн саналыг баталгаажуулах боломжгүй байна.");
  const missing = missingDraftFields(draft, rfq.kind);
  if (missing.length) throw new HumanQuoteError(`Үнийн саналын мэдээлэл дутуу байна: ${missing.join(", ")}. Тодруулж дахин илгээнэ үү.`, "incomplete");
  try {
    const data: HumanQuoteData = { ...input,
      inventory: input.inventory.map(record => inventorySchema.parse(record)),
      services: input.services.map(record => serviceSchema.parse(record)),
      slots: input.slots.map(record => slotSchema.parse(record)),
      settings: input.settings ? settingsSchema.parse(input.settings) : null,
    };
    if (data.settings && data.settings.merchantId !== merchantId) throw invalid();
    const resources = rfq.kind === "parts" ? data.inventory : data.services;
    if (!data.profile || data.profile.merchantId !== merchantId || data.profile.id !== merchantId ||
        [...data.inventory, ...data.services, ...data.slots].some(record => record.merchantId !== merchantId)) throw invalid();
    const requestedQuantities = new Map<number, number>(), resourceQuantities = new Map<string, number>();
    const lines: Quote["lines"] = [], terms = new Set<string>();
    let durationMinutes = 0;
    for (const line of draft.lines) {
      const item = rfq.items[line.itemIndex];
      const resource = resources.find(record => record.id === line.resourceId && record.merchantId === merchantId && record.active);
      if (!item || !resource || line.available !== true || line.quantity === null || line.unitPrice === null ||
          line.unitPrice.currency !== "MNT" || !withinPriceRules(line.unitPrice.amountMinor, resource, data.settings)) throw invalid();
      const itemQuantity = (requestedQuantities.get(line.itemIndex) ?? 0) + line.quantity;
      const resourceQuantity = (resourceQuantities.get(resource.id) ?? 0) + line.quantity;
      if (itemQuantity > item.quantity || ("stock" in resource && (resourceQuantity > resource.stock || line.condition !== resource.condition))) throw invalid();
      requestedQuantities.set(line.itemIndex, itemQuantity); resourceQuantities.set(resource.id, resourceQuantity);
      if (line.warranty !== null && line.warranty.trim() !== resource.warranty.trim()) throw invalid();
      // Reuse Phase 3 matching for every selected resource; a valid ID alone cannot change requested fitment/capability.
      const selected: HumanQuoteData = { ...data,
        inventory: "stock" in resource ? [resource] : [], services: "durationMinutes" in resource ? [resource] : [],
        slots: rfq.kind === "repair" ? data.slots.filter(slot => slot.id === draft.slotId) : data.slots,
      };
      const matched = calculateMerchantRFQ(merchantId, { ...envelope, rfq: { ...rfq, items: [{ ...item, quantity: line.quantity }] } }, selected, now);
      const publicLine = matched.quote?.lines.find(candidate => candidate.resourceId === resource.id);
      if (!publicLine || publicLine.quantity !== line.quantity) throw invalid();
      lines.push({ ...publicLine, quantity: line.quantity, unitPrice: line.unitPrice });
      terms.add(matched.quote!.terms);
      if ("durationMinutes" in resource) durationMinutes += resource.durationMinutes * line.quantity;
    }
    let slotStart = Infinity;
    if (rfq.kind === "repair") {
      const slot = data.slots.find(record => record.id === draft.slotId && record.merchantId === merchantId);
      if (!slot || slot.status !== "available" || slot.capacity < 1 || Date.parse(slot.startsAt) <= now.getTime() ||
          Date.parse(slot.endsAt) - Date.parse(slot.startsAt) < durationMinutes * 60000 ||
          (rfq.requiredBy && Date.parse(slot.endsAt) > Date.parse(rfq.requiredBy)) ||
          lines.some(line => !slot.serviceIds.includes(line.resourceId)))
        throw new HumanQuoteError("Сонгосон засварын цаг боломжгүй болсон байна. Өөр сул цаг сонгоно уу.");
      slotStart = Date.parse(slot.startsAt);
    }
    const createdAt = now.toISOString(), total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice.amountMinor, 0);
    const quote = quoteSchema.safeParse({ contractVersion: "1",
      id: `hq-${createHash("sha256").update(`${merchantId}:${rfq.id}:${revision}`).digest("hex").slice(0, 48)}`,
      merchantId, rfqId: rfq.id, buyerId: rfq.buyerId, revision, kind: rfq.kind, mode: "simulated", createdAt,
      lines, total: { amountMinor: total, currency: "MNT" },
      expiresAt: new Date(Math.min(Date.parse(envelope.expiresAt), now.getTime() + 15 * 60000, slotStart,
        rfq.requiredBy ? Date.parse(rfq.requiredBy) : Infinity)).toISOString(),
      availabilityCheckedAt: createdAt, reservation: false, status: "offered",
      terms: `ХҮН БАТАЛГААЖУУЛСАН ТУРШИЛТЫН ҮНИЙН САНАЛ. ${[...terms].join(" ")}`.slice(0, 4000),
    });
    if (!quote.success) throw invalid();
    return quote.data;
  } catch (error) {
    if (error instanceof HumanQuoteError) throw error;
    throw invalid();
  }
}
