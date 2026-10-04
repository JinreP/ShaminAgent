import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleGenAI } from "@google/genai";
import { merchantProfileSchema } from "../shared/merchant-contracts";
import { inventorySchema, serviceSchema, settingsSchema, slotSchema } from "../merchant/private-contracts";
import { demoSeedRecords } from "../merchant/server/seed";
import { readMerchantEnv } from "../merchant/server/env";
import { createAIProvider, geminiGenerateConfig, geminiPrompt, GeminiProvider, OyuLLMProvider, type AIProvider, type AIRequest } from "../merchant/server/providers";
import { extractQuoteDraft, missingDraftFields, quoteDraftProviderSchema, QuoteExtractionError } from "../merchant/telegram/extraction";
import { validateHumanQuote, HumanQuoteError, type HumanQuoteData } from "../merchant/telegram/validation";
import type { QuoteDraft } from "../merchant/telegram/contracts";
import type { MerchantRFQEnvelope } from "../merchant/a2a/contracts";

const merchantId = "demo-prius-parts", now = new Date("2026-10-05T12:00:00Z");
function request(id = merchantId, kind: "parts" | "repair" = "parts"): MerchantRFQEnvelope {
  return { contractVersion: "1", correlationId: "corr-human-test", expiresAt: "2026-10-05T13:00:00Z", rfq: {
    contractVersion: "1", id: "rfq-human", merchantId: id, buyerId: "private-buyer-identity", createdAt: "2026-10-05T11:00:00Z", kind,
    vehicle: { make: "Toyota", model: "Prius 30", year: 2012, vin: "JTDKN3DU0A0000001" },
    items: [{ description: kind === "parts" ? "Урд гупер" : "Гупер солих", quantity: 1 }], status: "received",
  } };
}
function records(id = merchantId): HumanQuoteData {
  const fixtures = demoSeedRecords().filter(fixture => fixture.record.merchantId === id);
  const values = (resource: string) => fixtures.filter(fixture => fixture.resource === resource).map(fixture => fixture.record);
  return { profile: merchantProfileSchema.parse(values("profile")[0]),
    inventory: values("inventory").map(record => inventorySchema.parse(record)),
    services: values("service").map(record => serviceSchema.parse(record)),
    slots: values("slot").map(record => slotSchema.parse(record)), settings: settingsSchema.parse(values("settings")[0]) };
}
function draft(data = records()): QuoteDraft {
  const resource = data.inventory[0] ?? data.services[0];
  return { lines: [{ itemIndex: 0, resourceId: resource.id, quantity: 1,
    unitPrice: { amountMinor: resource.price.amountMinor, currency: "MNT" },
    condition: "condition" in resource ? resource.condition : null, available: true, warranty: null }],
    slotId: data.slots[0]?.id ?? null };
}
const fake = (text: string): AIProvider => ({ generate: async () => ({ text, provider: "gemini", model: "mock-model" }) });

test("Gemini provider schema uses the documented compact subset while Zod retains complete validation", () => {
  const serialized = JSON.stringify(quoteDraftProviderSchema);
  for (const keyword of ["$schema", "pattern", "minLength", "maxLength", "exclusiveMinimum", "anyOf", "9007199254740991"])
    assert.ok(!serialized.includes(keyword), keyword);
  assert.deepEqual(quoteDraftProviderSchema.properties.slotId.type, ["string", "null"]);
  assert.deepEqual(quoteDraftProviderSchema.properties.lines.items.properties.condition, { type: ["string", "null"] });
  assert.deepEqual(quoteDraftProviderSchema.properties.lines.items.required,
    ["itemIndex", "resourceId", "quantity", "unitPrice", "condition", "available", "warranty"]);
});

test("official Gemini SDK converts portable quote schema through native responseSchema without network access", async () => {
  let body: { generationConfig: { responseSchema: { properties: Record<string, { type: string; nullable?: boolean; items?: { properties: Record<string, { type: string; nullable?: boolean }> } }> }; responseJsonSchema?: unknown } } | undefined;
  const config = geminiGenerateConfig({ prompt: "Туршилт", responseMimeType: "application/json", responseJsonSchema: quoteDraftProviderSchema }, "schema");
  assert.equal(config.responseJsonSchema, undefined);
  const sdk = new GoogleGenAI({ apiKey: "mock-test-key", httpOptions: { fetch: async (_url, options) => {
    body = JSON.parse(String(options?.body));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(draft()) }] } }] }),
      { status: 200, headers: { "content-type": "application/json" } });
  } } });
  await sdk.models.generateContent({ model: "mock-model", contents: "Туршилт", config });
  assert.equal(body!.generationConfig.responseJsonSchema, undefined);
  const schema = body!.generationConfig.responseSchema;
  assert.equal(schema.properties.slotId.type, "STRING"); assert.equal(schema.properties.slotId.nullable, true);
  const fields = schema.properties.lines.items!.properties;
  assert.equal(fields.unitPrice.type, "OBJECT"); assert.equal(fields.unitPrice.nullable, true);
  assert.equal(fields.available.type, "BOOLEAN"); assert.equal(fields.available.nullable, true);
});

test("Gemini JSON compatibility mode sends JSON MIME and schema guidance without claiming upstream schema enforcement", () => {
  const request: AIRequest = { prompt: "Саналыг танина уу.", responseMimeType: "application/json", responseJsonSchema: quoteDraftProviderSchema };
  const config = geminiGenerateConfig(request, "json");
  assert.equal(config.responseMimeType, "application/json"); assert.equal(config.responseJsonSchema, undefined); assert.equal(config.responseSchema, undefined);
  assert.ok(geminiPrompt(request, "json").includes(JSON.stringify(quoteDraftProviderSchema)));
  assert.equal(geminiPrompt(request, "schema"), request.prompt);
  assert.equal(geminiPrompt({ prompt: "Энгийн текст" }), "Энгийн текст");
  const env = { MONGODB_URI: "mongodb://127.0.0.1", MONGODB_DB: "mock", GEMINI_API_KEY: "mock-key", GEMINI_MODEL: "mock-model" };
  assert.equal(readMerchantEnv(env).GEMINI_STRUCTURED_OUTPUT_MODE, "json");
  assert.equal(readMerchantEnv({ ...env, GEMINI_STRUCTURED_OUTPUT_MODE: "schema" }).GEMINI_STRUCTURED_OUTPUT_MODE, "schema");
  assert.throws(() => readMerchantEnv({ ...env, GEMINI_STRUCTURED_OUTPUT_MODE: "silent-fallback" }));
});

test("Gemini extraction uses structured output and only necessary public RFQ/resource context", async () => {
  const data = records("demo-japan-used"), envelope = request("demo-japan-used"), expected = draft(data);
  expected.lines[0].unitPrice = { amountMinor: 28000000, currency: "MNT" };
  const merchantText = "Prius 30 урд гупер 280 мянга, хуучин, одоо бэлэн.";
  let captured: AIRequest | undefined;
  const provider = new GeminiProvider("mock-test-credential", "mock-model", async input => { captured = input; return { text: JSON.stringify(expected) }; });
  const result = await extractQuoteDraft(provider, envelope.rfq, data, merchantText);
  assert.deepEqual(result, expected);
  assert.equal(captured!.responseMimeType, "application/json");
  assert.equal((captured!.responseJsonSchema as { type: string }).type, "object");
  const sent = JSON.parse(captured!.prompt);
  assert.deepEqual(sent.request.vehicle, { make: "Toyota", model: "Prius 30", year: 2012 });
  assert.equal(sent.merchantText, merchantText);
  for (const key of ["buyerId", "vin", "minimumPrice", "price", "stock", "maxDiscountBps", "negotiationEnabled"])
    assert.ok(!captured!.prompt.includes(`"${key}"`), key);
  assert.ok(!captured!.prompt.includes(envelope.rfq.buyerId));
  assert.ok(!captured!.prompt.includes(envelope.rfq.vehicle.vin!));
  assert.match(captured!.systemInstruction!, /28000000/);
  assert.match(captured!.systemInstruction!, /Дутуу утгыг null/);
  // Successful language interpretation is separate from business acceptance.
  assert.throws(() => validateHumanQuote(data, envelope, result, now, 2), HumanQuoteError);
});

test("missing prices, condition, availability, resources and repair slots request Mongolian clarification", async () => {
  const incomplete: QuoteDraft = { lines: [{ itemIndex: 0, resourceId: null, quantity: null, unitPrice: null,
    condition: null, available: null, warranty: null }], slotId: null };
  assert.deepEqual(await extractQuoteDraft(fake(JSON.stringify(incomplete)), request().rfq, records(), "Гупер байгаа"), incomplete);
  const missing = missingDraftFields(incomplete, "parts");
  assert.equal(missing.length, 5); assert.ok(missing.every(value => /[\u0400-\u04ff]/.test(value)));
  assert.ok(missingDraftFields(incomplete, "repair").includes("засварын цаг"));
  assert.throws(() => validateHumanQuote(records(), request(), incomplete, now, 2), error => error instanceof HumanQuoteError && error.kind === "incomplete");
});

test("malformed, extra, unsafe, overlarge and failed provider responses are safely rejected", async () => {
  const envelope = request(), data = records();
  for (const output of ["not-json", "```json\n{}\n```", "null", JSON.stringify({ ...draft(), internalMinimumPrice: 1 }),
    JSON.stringify({ ...draft(), lines: [{ ...draft().lines[0], quantity: 1.5 }] }), " ".repeat(65537)])
    await assert.rejects(extractQuoteDraft(fake(output), envelope.rfq, data, "Үнэ 640 мянга, шинэ, бэлэн"), QuoteExtractionError);
  await assert.rejects(extractQuoteDraft({ generate: async () => { throw new Error("secret-provider-key-private-data"); } }, envelope.rfq, data, "Үнийн санал"),
    error => error instanceof QuoteExtractionError && !error.message.includes("secret-provider"));
});

test("extraction rejects oversize input and cross-merchant context before any provider call", async () => {
  let calls = 0;
  const provider: AIProvider = { generate: async () => { calls++; return { text: JSON.stringify(draft()), provider: "mock", model: "mock" }; } };
  await assert.rejects(extractQuoteDraft(provider, request().rfq, records(), "т".repeat(6001)), QuoteExtractionError);
  await assert.rejects(extractQuoteDraft(provider, request().rfq, records("demo-japan-used"), "Гупер бэлэн"), QuoteExtractionError);
  assert.equal(calls, 0);
});

test("human quote preserves public shared contract and stored warranty without reservations", () => {
  const data = records(), input = draft(data), envelope = request(), before = structuredClone(data);
  input.lines[0].unitPrice!.amountMinor = 64000000;
  const quote = validateHumanQuote(data, envelope, input, now, 2);
  assert.equal(quote.revision, 2); assert.equal(quote.total.amountMinor, 64000000); assert.equal(quote.reservation, false);
  assert.equal(quote.lines[0].description, "Урд гупер"); assert.match(quote.terms, /ХҮН БАТАЛГААЖУУЛСАН/);
  assert.match(quote.terms, new RegExp(data.inventory[0].warranty)); assert.deepEqual(data, before);
  assert.ok(!JSON.stringify(quote).includes("minimumPrice")); assert.ok(!JSON.stringify(quote).includes("maxDiscountBps"));
  assert.notEqual(quote.id, validateHumanQuote(data, envelope, input, now, 3).id);
  assert.equal(quote.id, validateHumanQuote(data, envelope, input, now, 2).id);
});

test("private floors and discount limits reject unsafe prices without revealing the limits", () => {
  const data = records(), input = draft(data);
  input.lines[0].unitPrice!.amountMinor = 62399999;
  assert.throws(() => validateHumanQuote(data, request(), input, now, 2), error => error instanceof HumanQuoteError &&
    !error.message.includes("624") && !error.message.includes("minimum") && /[\u0400-\u04ff]/.test(error.message));
  input.lines[0].unitPrice!.amountMinor = 62400000;
  assert.equal(validateHumanQuote(data, request(), input, now, 2).total.amountMinor, 62400000);
  data.settings!.maxDiscountBps = 1000;
  data.inventory[0].minimumPrice.amountMinor = 64000000;
  assert.throws(() => validateHumanQuote(data, request(), input, now, 2), HumanQuoteError);
});

test("missing or disabled negotiation settings cannot authorize a discount", () => {
  const data = records(), input = draft(data); input.lines[0].unitPrice!.amountMinor -= 1;
  assert.throws(() => validateHumanQuote({ ...data, settings: null }, request(), input, now, 2), HumanQuoteError);
  data.settings!.negotiationEnabled = false;
  assert.throws(() => validateHumanQuote(data, request(), input, now, 2), HumanQuoteError);
  input.lines[0].unitPrice!.amountMinor += 1;
  assert.equal(validateHumanQuote({ ...data, settings: null }, request(), input, now, 2).revision, 2);
});

test("human stock and request quantities are checked in aggregate including duplicate lines", () => {
  const data = records(), envelope = request(), input = draft(data);
  envelope.rfq.items[0].quantity = 10;
  input.lines[0].quantity = 3; input.lines.push({ ...structuredClone(input.lines[0]), quantity: 3 });
  assert.throws(() => validateHumanQuote(data, envelope, input, now, 2), HumanQuoteError);
  envelope.rfq.items[0].quantity = 1; input.lines[0].quantity = 1; input.lines[1].quantity = 1;
  assert.throws(() => validateHumanQuote(data, envelope, input, now, 2), HumanQuoteError);
  input.lines.pop(); data.inventory[0].stock = 0;
  assert.throws(() => validateHumanQuote(data, envelope, input, now, 2), HumanQuoteError);
});

test("merchant identity, selected resource, condition, currency and warranty cannot be forged", () => {
  const data = records(), envelope = request();
  for (const patch of [{ resourceId: "demo-japan-used-bumper" }, { resourceId: data.inventory[1].id },
    { condition: "used" }, { available: false }, { warranty: "Насан туршийн баталгаа" },
    { unitPrice: { amountMinor: 65000000, currency: "USD" } }, { itemIndex: 99 }] as const)
    assert.throws(() => validateHumanQuote(data, envelope, { ...draft(data), lines: [{ ...draft(data).lines[0], ...patch }] }, now, 2), HumanQuoteError);
  const foreign = records(); foreign.settings!.merchantId = "demo-japan-used";
  assert.throws(() => validateHumanQuote(foreign, envelope, draft(data), now, 2), HumanQuoteError);
  foreign.settings = data.settings; foreign.inventory[0].merchantId = "demo-japan-used";
  assert.throws(() => validateHumanQuote(foreign, envelope, draft(data), now, 2), HumanQuoteError);
});

test("expired RFQs, unsupported vehicles and public capability restrictions reject confirmation", () => {
  const data = records(), input = draft(data), envelope = request();
  assert.throws(() => validateHumanQuote(data, envelope, input, new Date(envelope.expiresAt), 2), /хугацаа дууссан/);
  envelope.rfq.vehicle.model = "Prius 20";
  assert.throws(() => validateHumanQuote(data, envelope, input, now, 2), HumanQuoteError);
  envelope.rfq.vehicle.model = "Prius 30"; data.profile!.capabilities = ["Toyota Prius 30", "Зүүн урд гэрэл"];
  assert.throws(() => validateHumanQuote(data, envelope, input, now, 2), HumanQuoteError);
});

test("repair requires an actual selected available scoped slot supporting aggregate duration and deadline", () => {
  const id = "demo-auto-care", data = records(id), envelope = request(id, "repair"), input = draft(data), before = structuredClone(data);
  input.lines[0].unitPrice!.amountMinor = 14500000;
  assert.equal(validateHumanQuote(data, envelope, input, now, 2).total.amountMinor, 14500000); assert.deepEqual(data, before);
  input.slotId = "foreign-slot";
  assert.throws(() => validateHumanQuote(data, envelope, input, now, 2), HumanQuoteError);
  input.slotId = data.slots[0].id; data.slots[0].status = "blocked";
  assert.throws(() => validateHumanQuote(data, envelope, input, now, 2), HumanQuoteError);
  data.slots[0].status = "available"; data.slots[0].serviceIds = [data.services[1].id];
  assert.throws(() => validateHumanQuote(data, envelope, input, now, 2), HumanQuoteError);
  data.slots[0].serviceIds = before.slots[0].serviceIds; envelope.rfq.items[0].quantity = 10; input.lines[0].quantity = 9;
  assert.throws(() => validateHumanQuote(data, envelope, input, now, 2), HumanQuoteError);
  envelope.rfq.items[0].quantity = 1; input.lines[0].quantity = 1; envelope.rfq.requiredBy = "2026-10-06T12:00:00Z";
  assert.throws(() => validateHumanQuote(data, envelope, input, now, 2), HumanQuoteError);
});

test("human quote totals reject unsafe integer multiplication", () => {
  const data = records(), envelope = request(), input = draft(data);
  data.inventory[0].price.amountMinor = Number.MAX_SAFE_INTEGER; data.inventory[0].minimumPrice.amountMinor = Number.MAX_SAFE_INTEGER;
  envelope.rfq.items[0].quantity = 2; input.lines[0].quantity = 2; input.lines[0].unitPrice!.amountMinor = Number.MAX_SAFE_INTEGER;
  assert.throws(() => validateHumanQuote(data, envelope, input, now, 2), HumanQuoteError);
});

test("AI_PROVIDER aliases preserve existing provider config and reject conflicting choices", async () => {
  const base = { MONGODB_URI: "mongodb://127.0.0.1", MONGODB_DB: "mock-test", GEMINI_API_KEY: "mock-key", GEMINI_MODEL: "mock-model" };
  assert.equal(readMerchantEnv({ ...base, AI_PROVIDER: "gemini" }).MERCHANT_AI_PROVIDER, "gemini");
  const oyu = readMerchantEnv({ ...base, AI_PROVIDER: "oyu", GEMINI_API_KEY: "" });
  assert.equal(oyu.MERCHANT_AI_PROVIDER, "oyullm"); assert.ok(createAIProvider(oyu) instanceof OyuLLMProvider);
  assert.equal(readMerchantEnv({ ...base, AI_PROVIDER: "oyu", MERCHANT_AI_PROVIDER: "oyullm" }).MERCHANT_AI_PROVIDER, "oyullm");
  assert.throws(() => readMerchantEnv({ ...base, AI_PROVIDER: "oyu", MERCHANT_AI_PROVIDER: "gemini" }), /AI_PROVIDER/);
  assert.throws(() => readMerchantEnv({ ...base, AI_PROVIDER: "gemini", MERCHANT_AI_PROVIDER: "oyullm" }), /AI_PROVIDER/);
  await assert.rejects(createAIProvider(oyu).generate({ prompt: "Туршилт" }), /documented API/);
});
