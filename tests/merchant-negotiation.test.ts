import { test } from "node:test";
import assert from "node:assert/strict";
import { merchantProfileSchema, negotiationSchema, quoteSchema, type Quote } from "../shared/merchant-contracts";
import { inventorySchema, serviceSchema, settingsSchema, slotSchema } from "../merchant/private-contracts";
import { demoSeedRecords } from "../merchant/server/seed";
import { calculateMerchantRFQ } from "../merchant/a2a/engine";
import type { MerchantRFQEnvelope } from "../merchant/a2a/contracts";
import type { HumanQuoteData } from "../merchant/telegram/validation";
import { getNegotiationResultRequestSchema, negotiateQuoteRequestSchema, negotiationResponseSchema, type NegotiationRequest } from "../merchant/negotiation/contracts";
import { NegotiationRuleError, priceNegotiatedQuote, validateHumanNegotiationPrice } from "../merchant/negotiation/engine";

const now = new Date("2026-10-05T12:00:00Z"), merchantId = "demo-prius-parts";
const mnt = (amount: number) => ({ amountMinor: amount * 100, currency: "MNT" });
function envelope(id = merchantId, kind: "parts" | "repair" = "parts"): MerchantRFQEnvelope {
  return { contractVersion: "1", correlationId: "corr-negotiation", expiresAt: "2026-10-05T13:00:00Z", rfq: {
    contractVersion: "1", id: "rfq-negotiation", merchantId: id, buyerId: "buyer-negotiation", createdAt: "2026-10-05T11:00:00Z",
    kind, vehicle: { make: "Toyota", model: "Prius 30", year: 2012 },
    items: [{ description: kind === "parts" ? "Урд гупер" : "Гупер солих", quantity: 1 }], status: "received",
  } };
}
function data(id = merchantId): HumanQuoteData {
  const fixtures = demoSeedRecords().filter(record => record.record.merchantId === id);
  const values = (resource: string) => fixtures.filter(record => record.resource === resource).map(record => record.record);
  return { profile: merchantProfileSchema.parse(values("profile")[0]),
    inventory: values("inventory").map(record => inventorySchema.parse(record)), services: values("service").map(record => serviceSchema.parse(record)),
    slots: values("slot").map(record => slotSchema.parse(record)), settings: settingsSchema.parse(values("settings")[0]) };
}
function original(records = data(), input = envelope()): Quote {
  return calculateMerchantRFQ(input.rfq.merchantId, input, records, now).quote!;
}
function request(): NegotiationRequest {
  const quote = original();
  return { contractVersion: "1", action: "negotiate_quote", rfqId: quote.rfqId, correlationId: "corr-price", expiresAt: "2026-10-05T12:10:00Z",
    negotiation: { contractVersion: "1", id: "neg-1", merchantId, buyerId: quote.buyerId, createdAt: now.toISOString(),
      quoteId: quote.id, quoteRevision: quote.revision, requestedTotal: mnt(640000), status: "requested" } };
}
const isRule = (kind: NegotiationRuleError["kind"]) => (error: unknown) => error instanceof NegotiationRuleError && error.kind === kind && /[\u0400-\u04ff]/.test(error.message);

test("negotiation settings defaults preserve existing stored records and constrain explicit policies", () => {
  const settings = data().settings!;
  const { maxNegotiationRounds, automaticNegotiationEnabled, negotiationTimeoutSeconds, ...legacy } = settings;
  assert.deepEqual(settingsSchema.parse(legacy), { ...legacy, maxNegotiationRounds: 3, automaticNegotiationEnabled: false, negotiationTimeoutSeconds: 300 });
  assert.equal(maxNegotiationRounds, 3); assert.equal(automaticNegotiationEnabled, false); assert.equal(negotiationTimeoutSeconds, 300);
  for (const patch of [{ maxNegotiationRounds: 0 }, { maxNegotiationRounds: 21 }, { negotiationTimeoutSeconds: 29 }, { negotiationTimeoutSeconds: 3601 }])
    assert.equal(settingsSchema.safeParse({ ...settings, ...patch }).success, false);
});

test("additive negotiation requests retain v1 fields and reject spoofed decisions/private extras/fractional prices", () => {
  const input = request();
  assert.deepEqual(negotiateQuoteRequestSchema.parse(input), input);
  assert.equal(negotiationSchema.safeParse(input.negotiation).success, true);
  for (const patch of [{ status: "accepted", responseTotal: mnt(640000) }, { responseTotal: mnt(640000) },
    { requestedTotal: { amountMinor: 1, currency: "MNT" } }, { requestedTotal: mnt(0) },
    { requestedTotal: { amountMinor: 64000000, currency: "USD" } }, { minimumPrice: mnt(1) }])
    assert.equal(negotiateQuoteRequestSchema.safeParse({ ...input, negotiation: { ...input.negotiation, ...patch } }).success, false);
  assert.equal(negotiateQuoteRequestSchema.safeParse({ ...input, expiresAt: input.negotiation.createdAt }).success, false);
  assert.equal(negotiateQuoteRequestSchema.safeParse({ ...input, buyerApproval: true }).success, false);
  assert.equal(getNegotiationResultRequestSchema.safeParse({ contractVersion: "1", action: "get_negotiation_result", rfqId: input.rfqId, negotiationId: input.negotiation.id }).success, true);
});

test("negotiation responses cannot attach quotes to pending/rejected decisions or misstate accepted arithmetic", () => {
  const input = request(), result = priceNegotiatedQuote(data(), original(), envelope(), input.negotiation.requestedTotal, now, 2);
  const base = { contractVersion: "1", merchantId, rfqId: input.rfqId, negotiationId: input.negotiation.id,
    correlationId: input.correlationId, expiresAt: input.expiresAt, round: 1, message: "Үнийн санал бэлэн боллоо.", negotiation: input.negotiation };
  assert.equal(negotiationResponseSchema.safeParse({ ...base, outcome: "pending" }).success, true);
  assert.equal(negotiationResponseSchema.safeParse({ ...base, outcome: "pending", quote: result.quote }).success, false);
  const accepted = { ...base, outcome: "accepted", negotiation: { ...input.negotiation, status: "accepted", responseTotal: result.quote.total }, quote: result.quote };
  assert.equal(negotiationResponseSchema.safeParse(accepted).success, true);
  assert.equal(negotiationResponseSchema.safeParse({ ...accepted, negotiation: { ...accepted.negotiation, responseTotal: mnt(639000) } }).success, false);
  assert.equal(negotiationResponseSchema.safeParse({ ...base, outcome: "rejected", negotiation: { ...input.negotiation, status: "rejected" }, quote: result.quote }).success, false);
  assert.equal(negotiationResponseSchema.safeParse({ ...accepted, merchantId: "demo-japan-used" }).success, false);
});

test("representable buyer price is accepted using scoped stored rules with a new non-reserving quote", () => {
  const records = data(), input = envelope(), quote = original(records, input), before = structuredClone({ records, quote, input });
  const result = priceNegotiatedQuote(records, quote, input, mnt(640000), now, 2, { expiresAt: "2026-10-05T12:05:00Z" });
  assert.equal(result.outcome, "accepted"); assert.equal(result.quote.total.amountMinor, 64000000);
  assert.equal(result.quote.revision, 2); assert.equal(result.quote.expiresAt, "2026-10-05T12:05:00.000Z");
  assert.equal(result.quote.reservation, false); assert.equal(result.quote.terms, quote.terms);
  assert.deepEqual(result.quote.lines.map(line => ({ ...line, unitPrice: quote.lines[0].unitPrice })), quote.lines);
  assert.deepEqual({ records, quote, input }, before); assert.equal(quoteSchema.safeParse(result.quote).success, true);
  assert.equal(result.quote.id, priceNegotiatedQuote(records, quote, input, mnt(640000), now, 2).quote.id);
  assert.notEqual(result.quote.id, priceNegotiatedQuote(records, quote, input, mnt(640000), now, 3).quote.id);
  const serialized = JSON.stringify(result);
  for (const privateField of ["minimumPrice", "maxDiscountBps", "humanApprovalRequired", "negotiationTimeoutSeconds"]) assert.ok(!serialized.includes(privateField));
});

test("below-limit offer gets a counteroffer while exact human approval cannot silently change price", () => {
  const result = priceNegotiatedQuote(data(), original(), envelope(), mnt(280000), now, 2);
  assert.equal(result.outcome, "countered"); assert.equal(result.quote.total.amountMinor, 62400000);
  assert.throws(() => validateHumanNegotiationPrice(data(), original(), envelope(), mnt(280000), now, 2), isRule("price_rejected"));
  assert.equal(validateHumanNegotiationPrice(data(), original(), envelope(), mnt(640000), now, 2).outcome, "accepted");
});

test("all private floors apply, including original quote price discount and whole-MNT ceiling", () => {
  const records = data(), quote = original(records);
  quote.lines[0].unitPrice = mnt(700000); quote.total = mnt(700000);
  assert.equal(priceNegotiatedQuote(records, quote, envelope(), mnt(660000), now, 2).quote.total.amountMinor, 67200000);
  records.inventory[0].minimumPrice = { amountMinor: 67300001, currency: "MNT" };
  records.inventory[0].price = mnt(700000);
  assert.equal(priceNegotiatedQuote(records, quote, envelope(), mnt(660000), now, 2).quote.total.amountMinor, 67300100);
  // Increasing current stored price can make the older quote impossible to discount safely.
  records.inventory[0].price = mnt(900000); records.inventory[0].minimumPrice = mnt(850000);
  assert.throws(() => priceNegotiatedQuote(records, quote, envelope(), mnt(660000), now, 2), isRule("price_rejected"));
});

test("greedy allocation reduces highest unit price first and respects every line floor", () => {
  const records = data(), input = envelope(); input.rfq.items.push({ description: "Зүүн урд гэрэл", quantity: 1 });
  const quote = original(records, input);
  const result = priceNegotiatedQuote(records, quote, input, mnt(1020000), now, 2);
  assert.equal(result.outcome, "accepted"); assert.deepEqual(result.quote.lines.map(line => line.unitPrice.amountMinor), [62400000, 39600000]);
  assert.equal(priceNegotiatedQuote(records, quote, input, mnt(1000000), now, 2).quote.total.amountMinor, 100800000);
});

test("quantity bundles counter unrepresentable prices without fractional unit prices", () => {
  const records = data(), input = envelope(); input.rfq.items[0].quantity = 2;
  const quote = original(records, input), result = priceNegotiatedQuote(records, quote, input, mnt(1299999), now, 2);
  assert.equal(result.outcome, "countered"); assert.equal(result.quote.total.amountMinor, 130000000);
  assert.ok(result.quote.lines.every(line => line.unitPrice.amountMinor % 100 === 0));
  assert.throws(() => validateHumanNegotiationPrice(records, quote, input, mnt(1299999), now, 2), isRule("price_rejected"));
});

test("repeated RFQ items and original resource lines preserve each quantity and scoped aggregate stock", () => {
  const records = data(), input = envelope(); input.rfq.items.push({ description: "Урд гупер", quantity: 1 });
  const quote = original(records, input);
  const result = priceNegotiatedQuote(records, quote, input, mnt(1280000), now, 2);
  assert.equal(result.quote.lines.length, quote.lines.length);
  assert.deepEqual(result.quote.lines.map(line => line.quantity), quote.lines.map(line => line.quantity));
  records.inventory[0].stock = 1;
  assert.throws(() => priceNegotiatedQuote(records, quote, input, mnt(1280000), now, 2), isRule("availability_changed"));
});

test("expiration, stale revisions, invalid currencies and unsupported price inputs fail safely", () => {
  const records = data(), input = envelope(), quote = original(records, input);
  assert.throws(() => priceNegotiatedQuote(records, quote, input, mnt(640000), new Date(quote.expiresAt), 2), isRule("quote_expired"));
  assert.throws(() => priceNegotiatedQuote(records, quote, input, mnt(640000), now, 1), isRule("stale_quote"));
  assert.throws(() => priceNegotiatedQuote(records, { ...quote, status: "superseded" }, input, mnt(640000), now, 2), isRule("stale_quote"));
  const expired = structuredClone(input); expired.expiresAt = "2026-10-05T11:59:00Z";
  assert.throws(() => priceNegotiatedQuote(records, quote, expired, mnt(640000), now, 2), isRule("rfq_expired"));
  assert.throws(() => priceNegotiatedQuote(records, quote, input, mnt(640000), now, 2, { expiresAt: now.toISOString() }), isRule("merchant_timeout"));
  for (const money of [{ amountMinor: 64000001, currency: "MNT" }, { amountMinor: 64000000, currency: "USD" }, mnt(0), mnt(-1), { amountMinor: 1.5, currency: "MNT" }])
    assert.throws(() => priceNegotiatedQuote(records, quote, input, money, now, 2), isRule("invalid_price"));
  assert.throws(() => priceNegotiatedQuote(records, quote, input, mnt(650001), now, 2), isRule("price_rejected"));
});

test("merchant isolation and active supported resources are rechecked before negotiated publication", () => {
  const records = data(), input = envelope(), quote = original(records, input);
  const crossMerchant = structuredClone(records); crossMerchant.inventory[0].merchantId = "demo-japan-used";
  assert.throws(() => priceNegotiatedQuote(crossMerchant, quote, input, mnt(640000), now, 2), isRule("availability_changed"));
  const wrongBuyer = structuredClone(quote); wrongBuyer.buyerId = "another-buyer";
  assert.throws(() => priceNegotiatedQuote(records, wrongBuyer, input, mnt(640000), now, 2), isRule("stale_quote"));
  records.inventory[0].active = false;
  assert.throws(() => priceNegotiatedQuote(records, quote, input, mnt(640000), now, 2), isRule("availability_changed"));
  records.inventory[0].active = true; records.profile!.capabilities = ["Toyota Prius 30", "Зүүн урд гэрэл"];
  assert.throws(() => priceNegotiatedQuote(records, quote, input, mnt(640000), now, 2), isRule("availability_changed"));
  records.profile!.active = false;
  assert.throws(() => priceNegotiatedQuote(records, quote, input, mnt(640000), now, 2), isRule("merchant_rejected"));
});

test("disabled or absent negotiation settings cannot authorize a negotiated quote", () => {
  const records = data(), quote = original(records); records.settings!.negotiationEnabled = false;
  assert.throws(() => priceNegotiatedQuote(records, quote, envelope(), mnt(640000), now, 2), isRule("negotiation_disabled"));
  records.settings = null;
  assert.throws(() => priceNegotiatedQuote(records, quote, envelope(), mnt(640000), now, 2), isRule("negotiation_disabled"));
});

test("repair preserves its immutable offered window and rejects unavailable slots rather than selecting another", () => {
  const id = "demo-auto-care", records = data(id), input = envelope(id, "repair"), response = calculateMerchantRFQ(id, input, records, now), quote = response.quote!;
  const options = { serviceWindow: response.serviceWindow! };
  const result = priceNegotiatedQuote(records, quote, input, mnt(145000), now, 2, options);
  assert.equal(result.outcome, "accepted"); assert.deepEqual(result.serviceWindow, options.serviceWindow); assert.equal(result.quote.reservation, false);
  assert.throws(() => priceNegotiatedQuote(records, quote, input, mnt(145000), now, 2), isRule("availability_changed"));
  records.slots[0].status = "blocked";
  assert.throws(() => priceNegotiatedQuote(records, quote, input, mnt(145000), now, 2, options), isRule("availability_changed"));
  records.slots[0].status = "available"; records.slots[0].serviceIds = [records.services[1].id];
  assert.throws(() => priceNegotiatedQuote(records, quote, input, mnt(145000), now, 2, options), isRule("availability_changed"));
});

test("public negotiation errors contain Mongolian explanation and no merchant-private numbers", () => {
  const records = data(), quote = original(records); records.inventory[0].price = mnt(950000); records.inventory[0].minimumPrice = mnt(912345);
  assert.throws(() => priceNegotiatedQuote(records, quote, envelope(), mnt(640000), now, 2), error => error instanceof NegotiationRuleError &&
    !error.message.includes("912345") && !error.message.includes("maxDiscount") && /[\u0400-\u04ff]/.test(error.message));
});
