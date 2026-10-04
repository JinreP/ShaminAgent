import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteSchema, approvalRequestSchema, merchantProfileSchema, transactionSchema, rfqSchema, negotiationSchema, approvalSchema, auditEventSchema } from "../shared/merchant-contracts";
import { readMerchantEnv } from "../merchant/server/env";
import { GeminiProvider, OyuLLMProvider, AnirSpeechProvider, createSpeechProvider } from "../merchant/server/providers";
import { assertMerchantScope, MerchantRepository } from "../merchant/server/repository";
import { initializeMerchantDatabase, merchantIndexes } from "../merchant/server/database";
import type { Db, MongoClient } from "mongodb";

const now = "2026-10-04T12:00:00Z";
const base = { contractVersion: "1", id: "q1", merchantId: "m1", createdAt: now };
const money = { amountMinor: 100, currency: "MNT" };
const quote = { ...base, rfqId: "r1", buyerId: "b1", revision: 1, kind: "parts", mode: "simulated",
  lines: [{ resourceId: "part1", description: "Test fixture", quantity: 2, unitPrice: money }],
  total: { ...money, amountMinor: 200 }, expiresAt: "2026-10-04T12:15:00Z", availabilityCheckedAt: now,
  reservation: false, terms: "Test quote only", status: "offered" };
test("quote validates arithmetic, currency, expiration and non-reservation", () => {
  assert.equal(quoteSchema.parse(quote).reservation, false);
  for (const patch of [{ total: money }, { total: { ...quote.total, currency: "USD" } },
    { expiresAt: now }, { reservation: true }, { minimumPrice: 1 }, { total: { ...money, amountMinor: 0.5 } }])
    assert.equal(quoteSchema.safeParse({ ...quote, ...patch }).success, false);
});
test("profile rejects mismatched identity and private pricing", () => {
  const profile = { ...base, id: "m1", name: "Fixture", kind: "parts", mode: "simulated", capabilities: ["parts"], location: "Test", active: true };
  assert.equal(merchantProfileSchema.safeParse(profile).success, true);
  assert.equal(merchantProfileSchema.safeParse({ ...profile, id: "m2" }).success, false);
  assert.equal(merchantProfileSchema.safeParse({ ...profile, minimumPrice: 1 }).success, false);
});
test("RFQs require real request items and positive quantities", () => {
  const request = { ...base, buyerId: "b1", kind: "parts", vehicle: { make: "Toyota", model: "Prius" }, items: [{ description: "Bumper", quantity: 1 }], status: "received" };
  assert.equal(rfqSchema.safeParse(request).success, true);
  assert.equal(rfqSchema.safeParse({ ...request, items: [] }).success, false);
  assert.equal(rfqSchema.safeParse({ ...request, items: [{ description: "Bumper", quantity: 0 }] }).success, false);
});
test("negotiations reject private limits and require response for counteroffer", () => {
  const value = { ...base, quoteId: "q1", quoteRevision: 1, buyerId: "b1", requestedTotal: money, status: "requested" };
  assert.equal(negotiationSchema.safeParse(value).success, true);
  assert.equal(negotiationSchema.safeParse({ ...value, status: "countered" }).success, false);
  assert.equal(negotiationSchema.safeParse({ ...value, minimumPrice: money }).success, false);
});
test("approval records enforce expiry and audit rejects arbitrary secret payloads", () => {
  const approval = { ...base, buyerId: "b1", quoteId: "q1", quoteRevision: 1, approvedTotal: money, status: "verified", verifiedAt: now, expiresAt: "2026-10-04T12:15:00Z", verificationReference: "auth1" };
  assert.equal(approvalSchema.safeParse(approval).success, true);
  assert.equal(approvalSchema.safeParse({ ...approval, expiresAt: now }).success, false);
  const audit = { ...base, actorId: "m1", actorKind: "merchant", action: "quote_created", entityId: "q1", correlationId: "r1", outcome: "success" };
  assert.equal(auditEventSchema.safeParse(audit).success, true);
  assert.equal(auditEventSchema.safeParse({ ...audit, payload: { secret: "private" } }).success, false);
});
test("approval input cannot assert verification or spoof buyer identity", () => {
  const request = { contractVersion: "1", merchantId: "m1", quoteId: "q1", quoteRevision: 1, approvedTotal: money, approved: true, idempotencyKey: "request1" };
  assert.equal(approvalRequestSchema.safeParse(request).success, true);
  for (const patch of [{ approved: false }, { verifiedAt: now }, { buyerId: "spoof" }, { quoteRevision: 0 }])
    assert.equal(approvalRequestSchema.safeParse({ ...request, ...patch }).success, false);
});
test("transaction requires approval reference and mock payment label", () => {
  const value = { ...base, buyerId: "b1", quoteId: "q1", quoteRevision: 1, approvalId: "a1", idempotencyKey: "key1", kind: "parts_order", total: money, mode: "simulated", paymentMode: "mock", status: "pending", availabilityCheckedAt: now };
  assert.equal(transactionSchema.safeParse(value).success, true);
  assert.equal(transactionSchema.safeParse({ ...value, approvalId: undefined }).success, false);
  assert.equal(transactionSchema.safeParse({ ...value, paymentMode: "real" }).success, false);
});
test("environment validates provider requirements without leaking secrets", () => {
  const env = { MONGODB_URI: "mongodb://localhost", MONGODB_DB: "test", GEMINI_API_KEY: "secret-value", GEMINI_MODEL: "configured-model" };
  assert.equal(readMerchantEnv(env).MERCHANT_AI_PROVIDER, "gemini");
  assert.throws(() => readMerchantEnv({ ...env, MONGODB_URI: "secret-value" }), error => error instanceof Error && !error.message.includes("secret-value"));
  assert.throws(() => readMerchantEnv({ ...env, GEMINI_API_KEY: "" }));
  assert.equal(readMerchantEnv({ ...env, MERCHANT_AI_PROVIDER: "oyullm", GEMINI_API_KEY: "" }).MERCHANT_AI_PROVIDER, "oyullm");
});
test("Gemini adapter forwards prompt and handles empty output and abort", async () => {
  let prompt = "";
  const provider = new GeminiProvider("test", "model", async request => { prompt = request.prompt; return { text: "response" }; });
  assert.deepEqual(await provider.generate({ prompt: "request" }), { text: "response", provider: "gemini", model: "model" });
  assert.equal(prompt, "request");
  await assert.rejects(new GeminiProvider("test", "model", async () => ({})).generate({ prompt: "request" }), /no text/);
  await assert.rejects(provider.generate({ prompt: "request", signal: AbortSignal.abort() }));
});
test("future providers fail explicitly without network requests", async () => {
  await assert.rejects(new OyuLLMProvider().generate({ prompt: "hello" }), /documented API/);
  await assert.rejects(new AnirSpeechProvider().transcribe({ audio: new Uint8Array(), mimeType: "audio/wav" }), /documented API/);
  await assert.rejects(createSpeechProvider(readMerchantEnv({ MONGODB_URI: "mongodb://localhost", MONGODB_DB: "test", MERCHANT_AI_PROVIDER: "oyullm" })).transcribe({ audio: new Uint8Array(), mimeType: "audio/wav" }), /disabled/);
});
test("merchant reads scope queries and reject cross-merchant writes before persistence", async () => {
  assert.throws(() => assertMerchantScope("m1", { merchantId: "m2" }), /scope/);
  let filter: unknown;
  const db = { collection: () => ({ findOne: async (query: unknown) => { filter = query; return null; } }) } as unknown as Db;
  const repository = new MerchantRepository({} as MongoClient, db, "m1");
  assert.equal(await repository.findById("merchant_quotes", "q1"), null);
  assert.deepEqual(filter, { merchantId: "m1", id: "q1" });
  await assert.rejects(repository.insertAudited("merchant_quotes", quoteSchema.parse({ ...quote, merchantId: "m2" }), {
    ...base, contractVersion: "1", id: "audit1", actorId: "m1", actorKind: "merchant", action: "quote_created", entityId: "q1", correlationId: "r1", outcome: "success",
  }), /scope/);
});
test("all collections initialize indexes and duplicate prevention is configured", async () => {
  const names: string[] = [];
  await initializeMerchantDatabase({ collection: (name: string) => ({ createIndexes: async () => { names.push(name); } }) } as unknown as Db);
  assert.deepEqual(names, Object.keys(merchantIndexes));
  const unique = merchantIndexes.merchant_transactions.filter(i => i.unique);
  assert.ok(unique.some(i => "idempotencyKey" in i.key));
  assert.ok(unique.some(i => "approvalId" in i.key));
  assert.ok(unique.every(i => "merchantId" in i.key));
});
