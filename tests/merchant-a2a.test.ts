import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { getA2AConfig, authenticateA2A } from "../merchant/a2a/auth";
import { calculateMerchantRFQ } from "../merchant/a2a/engine";
import { createMerchantRFQProcessor, RFQInputError } from "../merchant/a2a/service";
import { demoSeedRecords } from "../merchant/server/seed";
import { inventorySchema, serviceSchema, slotSchema } from "../merchant/private-contracts";
import { merchantProfileSchema } from "../shared/merchant-contracts";
import type { MerchantRFQData } from "../merchant/a2a/store";
import { merchantRFQEnvelopeSchema, type MerchantRFQEnvelope } from "../merchant/a2a/contracts";

const merchantId = "demo-prius-parts", buyerId = "test-buyer", now = new Date("2026-10-05T12:00:00Z");
function request(id = merchantId, kind: "parts" | "repair" = "parts"): MerchantRFQEnvelope {
  return { contractVersion: "1", correlationId: "corr-test", expiresAt: "2026-10-05T13:00:00Z",
    rfq: { contractVersion: "1", id: "rfq-test", merchantId: id, buyerId, createdAt: "2026-10-05T11:00:00Z", kind,
      vehicle: { make: "Toyota", model: "Prius 30", year: 2012 }, items: [{ description: kind === "parts" ? "Урд гупер" : "Гупер солих", quantity: 1 }], status: "received" } };
}
function records(id = merchantId): MerchantRFQData {
  const fixtures = demoSeedRecords().filter(f => f.record.merchantId === id);
  const resource = (key: string) => fixtures.filter(f => f.resource === key).map(f => f.record);
  return { profile: merchantProfileSchema.parse(resource("profile")[0]),
    inventory: resource("inventory").map(r => inventorySchema.parse(r)), services: resource("service").map(r => serviceSchema.parse(r)),
    slots: resource("slot").map(r => slotSchema.parse(r)) };
}
test("A2A RFQ envelope is additive, strict and requires initial status/valid expiration", () => {
  assert.equal(merchantRFQEnvelopeSchema.parse(request()).rfq.status, "received");
  assert.equal(merchantRFQEnvelopeSchema.safeParse({ ...request(), privatePrice: 1 }).success, false);
  const invalid = request(); invalid.rfq.status = "quoted";
  assert.equal(merchantRFQEnvelopeSchema.safeParse(invalid).success, false);
  assert.equal(merchantRFQEnvelopeSchema.safeParse({ ...request(), expiresAt: "2026-10-05T10:00:00Z" }).success, false);
});
test("stored merchant prices generate non-reserving Mongolian public quotes", () => {
  for (const [id, amount] of [[merchantId, 65000000], ["demo-japan-used", 55000000], ["demo-oem-center", 110000000]] as const) {
    const data = records(id), before = structuredClone(data);
    const response = calculateMerchantRFQ(id, request(id), data, now);
    assert.equal(response.outcome, "quoted"); assert.equal(response.quote!.total.amountMinor, amount);
    assert.equal(response.quote!.reservation, false); assert.match(response.quote!.terms, /ТУРШИЛТ/);
    assert.deepEqual(data, before); assert.ok(!JSON.stringify(response).includes("minimumPrice"));
  }
});
test("parts support partial availability, insufficient stock, preference, exact stored part number", () => {
  const data = records(), input = request(); input.rfq.items[0].quantity = 7;
  const partial = calculateMerchantRFQ(merchantId, input, data, now);
  assert.equal(partial.outcome, "partial"); assert.equal(partial.quote!.lines[0].quantity, 5);
  data.inventory.forEach(r => r.stock = 0);
  assert.equal(calculateMerchantRFQ(merchantId, input, data, now).outcome, "declined");
  const preferred = request(); preferred.rfq.items[0].preference = "oem";
  assert.equal(calculateMerchantRFQ(merchantId, preferred, records(), now).outcome, "declined");
  const exact = request(); exact.rfq.items[0].description = "Хүссэн сэлбэг"; exact.rfq.items[0].partNumber = "SIM-PRIUS30-0-0";
  assert.equal(calculateMerchantRFQ(merchantId, exact, records(), now).outcome, "quoted");
});
test("repeated RFQ lines share stock and matching candidates prefer sufficient availability", () => {
  const data = records(), input = request(); input.rfq.items = [{ description: "Урд гупер", quantity: 4 }, { description: "Урд гупер", quantity: 4 }];
  const response = calculateMerchantRFQ(merchantId, input, data, now);
  assert.equal(response.quote!.lines.reduce((sum, line) => sum + line.quantity, 0), 5);
  const bumper = data.inventory.find(r => r.id.endsWith("bumper"))!;
  bumper.stock = 1; data.inventory.push({ ...bumper, id: "z-extra", stock: 10 });
  input.rfq.items = [{ description: "Урд гупер", quantity: 5 }];
  assert.equal(calculateMerchantRFQ(merchantId, input, data, now).quote!.lines[0].quantity, 5);
  data.inventory.find(r => r.id === "z-extra")!.stock = 4;
  const combined = calculateMerchantRFQ(merchantId, input, data, now);
  assert.equal(combined.outcome, "quoted");
  assert.equal(combined.quote!.lines.reduce((sum, line) => sum + line.quantity, 0), 5);
});
test("vehicles, public capabilities, disabled merchants and expired requests reject safely", () => {
  for (const vehicle of [{ make: "Toyota", model: "Prius 20", year: 2008 }, { make: "Toyota", model: "Prius 30", year: 2020 },
    { make: "Toyota", model: "Prius" }, { make: "Honda", model: "Prius 30" }]) {
    const input = request(); input.rfq.vehicle = vehicle;
    assert.equal(calculateMerchantRFQ(merchantId, input, records(), now).issues[0].code, "unsupported_vehicle");
  }
  const data = records(); data.profile!.active = false;
  assert.equal(calculateMerchantRFQ(merchantId, request(), data, now).issues[0].code, "merchant_rejected");
  assert.equal(calculateMerchantRFQ(merchantId, request(), records(), new Date("2026-10-05T13:00:00Z")).outcome, "expired");
  const restricted = records(); restricted.profile!.capabilities = ["Toyota Prius 30", "Зүүн урд гэрэл"];
  assert.equal(calculateMerchantRFQ(merchantId, request(), restricted, now).outcome, "declined");
  const foreign = records(); foreign.inventory[0].merchantId = "demo-japan-used";
  assert.throws(() => calculateMerchantRFQ(merchantId, request(), foreign, now));
});
test("repair quotes use stored labor, duration and eligible slots without reserving", () => {
  const id = "demo-auto-care", input = request(id, "repair"), data = records(id), before = structuredClone(data);
  const response = calculateMerchantRFQ(id, input, data, now);
  assert.equal(response.outcome, "quoted"); assert.equal(response.quote!.total.amountMinor, 15000000);
  assert.ok(response.serviceWindow); assert.match(response.quote!.terms, /Шалгах шаардлагатай/); assert.deepEqual(data, before);
  data.slots.forEach(s => s.status = "blocked");
  assert.equal(calculateMerchantRFQ(id, input, data, now).issues[0].code, "no_repair_slot");
  input.rfq.items[0].quantity = 100;
  assert.equal(calculateMerchantRFQ(id, input, records(id), now).issues[0].code, "no_repair_slot");
});
test("service checks authenticated scope/schema before requesting any Mongo connection", async () => {
  let connections = 0;
  const process = createMerchantRFQProcessor(async () => { connections++; throw new Error("private-db-uri-secret"); });
  const input = request(); input.rfq.createdAt = new Date(Date.now() - 1000).toISOString(); input.expiresAt = new Date(Date.now() + 3600000).toISOString();
  await assert.rejects(process(merchantId, "other-buyer", input), RFQInputError);
  await assert.rejects(process(merchantId, buyerId, { ...input, extra: true }), RFQInputError);
  assert.equal(connections, 0);
  const failure = await process(merchantId, buyerId, input);
  assert.ok("outcome" in failure);
  assert.equal(failure.outcome, "failed"); assert.ok(!JSON.stringify(failure).includes("private-db"));
});
test("demo A2A auth is independently configured, loopback only, and forbidden in production", async () => {
  const env = { NODE_ENV: "test", MERCHANT_A2A_ORIGIN: "http://localhost:3000", MERCHANT_A2A_AUTH_MODE: "demo", MERCHANT_A2A_DEMO_ENABLED: "true",
    MERCHANT_A2A_DEMO_TOKEN: "demo-test-with-at-least-32-characters", MERCHANT_A2A_DEMO_BUYER_ID: buyerId };
  const req = new Request(`${env.MERCHANT_A2A_ORIGIN}/api/a2a/${merchantId}`, { headers: { Authorization: `Bearer ${env.MERCHANT_A2A_DEMO_TOKEN}` } });
  assert.equal((await authenticateA2A(req, merchantId, env)).buyerId, buyerId);
  await assert.rejects(authenticateA2A(req, merchantId, { ...env, MERCHANT_A2A_DEMO_ENABLED: "false" }));
  await assert.rejects(authenticateA2A(req, merchantId, { ...env, NODE_ENV: "production", MERCHANT_A2A_ORIGIN: "https://merchant.example" }));
  await assert.rejects(authenticateA2A(req, merchantId, { ...env, MERCHANT_A2A_ORIGIN: "https://merchant.example" }));
  await assert.rejects(authenticateA2A(new Request(req.url, { headers: { Authorization: "Bearer bad" } }), merchantId, env));
  assert.equal(getA2AConfig({}).authMode, "disabled");
});
test("production JWT validates signature, expiry, issuer, audience and signed merchant scope", async () => {
  const keys = await generateKeyPair("ES256"), jwk = await exportJWK(keys.publicKey);
  jwk.kid = "test-key"; jwk.alg = "ES256";
  const resolve = createLocalJWKSet({ keys: [jwk] });
  const env = { NODE_ENV: "production", MERCHANT_A2A_AUTH_MODE: "jwt", MERCHANT_A2A_ORIGIN: "https://merchant.example",
    MERCHANT_A2A_JWKS_URI: "https://identity.example/jwks", MERCHANT_A2A_ISSUER: "https://identity.example", MERCHANT_A2A_AUDIENCE: "zahagent-merchants" };
  const sign = (claims: Record<string, unknown> = {}, issuer = env.MERCHANT_A2A_ISSUER) => new SignJWT({ buyer_id: buyerId, merchant_ids: [merchantId], ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" }).setSubject("verified-user").setIssuedAt().setIssuer(issuer).setAudience(env.MERCHANT_A2A_AUDIENCE)
    .setExpirationTime(claims.exp as number ?? "5m").sign(keys.privateKey);
  const req = (token: string) => new Request(`${env.MERCHANT_A2A_ORIGIN}/api/a2a/${merchantId}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await authenticateA2A(req(await sign()), merchantId, env, resolve)).buyerId, buyerId);
  await assert.rejects(authenticateA2A(req(await sign()), "demo-japan-used", env, resolve));
  await assert.rejects(authenticateA2A(req(await sign({}, "https://wrong.example")), merchantId, env, resolve));
  await assert.rejects(authenticateA2A(req(await sign()), merchantId, { ...env, MERCHANT_A2A_AUDIENCE: "wrong-audience" }, resolve));
  await assert.rejects(authenticateA2A(req(await sign({ exp: 1 })), merchantId, env, resolve));
  await assert.rejects(authenticateA2A(req(`${await sign()}x`), merchantId, env, resolve));
});
