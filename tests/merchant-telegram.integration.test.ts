import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { createMerchantRFQProcessor } from "../merchant/a2a/service";
import { getMerchantAgentCard } from "../merchant/a2a/cards";
import { authenticateA2A } from "../merchant/a2a/auth";
import { handleMerchantA2A } from "../merchant/a2a/transport";
import { seedDemoMerchants } from "../merchant/server/seed";
import { DEMO_MERCHANTS } from "../merchant/demo-merchants";
import { createTelegramRuntime } from "../merchant/telegram/service";
import { readTelegramConfig } from "../merchant/telegram/config";
import { TelegramMerchantStore } from "../merchant/telegram/store";
import { TelegramAPIError, type TelegramAPI, type InlineKeyboard } from "../merchant/telegram/api";
import { handleTelegramWebhook } from "../merchant/telegram/webhook";
import { acquireTelegramLease, releaseTelegramLease, withTelegramWebhookLease } from "../merchant/telegram/worker";
import type { AIProvider } from "../merchant/server/providers";
import type { MerchantRFQEnvelope } from "../merchant/a2a/contracts";
import type { QuoteDraft, TelegramBinding, TelegramUpdate } from "../merchant/telegram/contracts";
import { sendMerchantRFQ, sendQuoteUpdates } from "./helpers/merchant-buyer";

test("persistent Telegram human quotes integrate with genuine A2A using disposable MongoDB and mocked external APIs", {
  skip: process.env.MERCHANT_TELEGRAM_LOCAL_INTEGRATION !== "true", timeout: 600000,
}, async t => {
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger", ip: "127.0.0.1" } });
  const client = new MongoClient(replica.getUri()), db = client.db("merchant_phase4_disposable");
  const origin = "http://localhost:3000", buyerId = "phase4-isolated-buyer", a2aToken = "phase4-isolated-token-more-than-32-chars";
  const config = readTelegramConfig({ NODE_ENV: "test", MERCHANT_TELEGRAM_ENABLED: "true", TELEGRAM_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz_test_token",
    MERCHANT_TELEGRAM_AUTH_MODE: "demo", MERCHANT_TELEGRAM_DEMO_ENABLED: "true" });
  const webhookConfig = { ...config, mode: "webhook" as const, webhookUrl: "https://test.example/api/merchant-telegram/webhook", webhookSecret: "isolated-webhook-secret-32-characters" };
  const sent: { chatId: string; text: string; buttons?: InlineKeyboard; message_id: number }[] = [];
  let messageId = 0, updateId = 0, extractionCalls = 0, expiredAck = false;
  const outputs: QuoteDraft[] = [];
  const telegram: TelegramAPI = {
    async sendMessage(chatId, text, buttons) { const message = { chatId, text, buttons, message_id: ++messageId }; sent.push(message); return message; },
    async answerCallbackQuery() { if (expiredAck) { expiredAck = false; throw new TelegramAPIError("rejected"); } },
    async getMe() { return { id: 123456, is_bot: true }; }, async deleteWebhook() {}, async setWebhook() {}, async getUpdates() { return []; },
    async getWebhookInfo() { return { url: "", pending_update_count: 0 }; },
  };
  const ai: AIProvider = { async generate(request) {
    extractionCalls++;
    assert.ok(!/minimumPrice|maxDiscountBps|buyerId|vin|stock/.test(request.prompt));
    const output = outputs.shift(); if (!output) throw new Error("No mocked Gemini output available");
    return { provider: "gemini-mock", model: "isolated-test", text: JSON.stringify(output) };
  } };
  const runtime = createTelegramRuntime({ client, db, config, telegram, ai });
  const store = new TelegramMerchantStore(client, db);
  const processor = createMerchantRFQProcessor(async () => ({ client, db }));
  const bindings = new Map<string, TelegramBinding>();
  const factoryFor = (trustedBuyer = buyerId) => new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: async (input, init) => {
    const headers = new Headers(init?.headers); headers.set("Authorization", `Bearer ${a2aToken}`);
    const request = new Request(input, { ...init, headers });
    const id = new URL(request.url).pathname.split("/").at(-1)!;
    return handleMerchantA2A(request, id, { origin, processRFQ: processor, authenticate: (request, merchantId) => authenticateA2A(request, merchantId,
      { NODE_ENV: "test", MERCHANT_A2A_ORIGIN: origin, MERCHANT_A2A_AUTH_MODE: "demo", MERCHANT_A2A_DEMO_ENABLED: "true",
        MERCHANT_A2A_DEMO_TOKEN: a2aToken, MERCHANT_A2A_DEMO_BUYER_ID: trustedBuyer }) });
  } })] });
  // SDK fetch wrapper supplies the transport's trusted Bearer credential, never a client merchant ID authorization.
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: async (input, init) => {
    const headers = new Headers(init?.headers); headers.set("Authorization", `Bearer ${a2aToken}`);
    return factoryFetch(input, { ...init, headers });
  } })] });
  async function factoryFetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = new Request(input, init), id = new URL(request.url).pathname.split("/").at(-1)!;
    return handleMerchantA2A(request, id, { origin, processRFQ: processor, authenticate: (request, merchantId) => authenticateA2A(request, merchantId,
      { NODE_ENV: "test", MERCHANT_A2A_ORIGIN: origin, MERCHANT_A2A_AUTH_MODE: "demo", MERCHANT_A2A_DEMO_ENABLED: "true",
        MERCHANT_A2A_DEMO_TOKEN: a2aToken, MERCHANT_A2A_DEMO_BUYER_ID: buyerId }) });
  }
  function envelope(merchantId: string, id: string, kind: "parts" | "repair" = "parts"): MerchantRFQEnvelope {
    return { contractVersion: "1", correlationId: `corr-${id}`, expiresAt: new Date(Date.now() + 3600000).toISOString(),
      rfq: { contractVersion: "1", id, merchantId, buyerId, createdAt: new Date(Date.now() - 10000).toISOString(), kind,
        vehicle: { make: "Toyota", model: "Prius 30", year: 2012 }, items: [{ description: kind === "parts" ? "Урд гупер" : "Гупер солих", quantity: 1 }], status: "received" } };
  }
  function message(binding: TelegramBinding, text: string, replyId?: number): TelegramUpdate {
    return { update_id: ++updateId, message: { message_id: updateId, from: { id: Number(binding.userId) }, chat: { id: Number(binding.chatId), type: "private" }, text,
      ...(replyId ? { reply_to_message: { message_id: replyId } } : {}) } };
  }
  function callback(binding: TelegramBinding, data: string): TelegramUpdate {
    return { update_id: ++updateId, callback_query: { id: `callback-${updateId}`, from: { id: Number(binding.userId) }, data,
      message: { message_id: 1, chat: { id: Number(binding.chatId), type: "private" } } } };
  }
  function draft(merchantId: string, amount = 64000000): QuoteDraft {
    return { lines: [{ itemIndex: 0, resourceId: `${merchantId}-bumper`, quantity: 1, unitPrice: { amountMinor: amount, currency: "MNT" },
      condition: merchantId === "demo-japan-used" ? "used" : merchantId === "demo-oem-center" ? "oem" : "aftermarket", available: true, warranty: null }], slotId: null };
  }
  async function newDraft(binding: TelegramBinding, rfqId: string, output: QuoteDraft) {
    const notification = await db.collection("merchant_telegram_notifications").findOne({ merchantId: binding.merchantId, rfqId });
    assert.ok(notification);
    await runtime.processUpdate(callback(binding, `a:${notification.id}`));
    outputs.push(output);
    await runtime.processUpdate(message(binding, output.slotId ? `Гупер солих ${output.lines[0].unitPrice!.amountMinor / 100} төгрөг, боломжтой. Цаг: ${output.slotId}` :
      "Урд гупер 640 мянган төгрөг, үйлдвэрийн бус шинэ, бэлэн."));
    const record = await db.collection("merchant_telegram_drafts").findOne({ merchantId: binding.merchantId, rfqId, status: "review" });
    assert.ok(record); return record;
  }
  try {
    await client.connect(); await seedDemoMerchants(client, db);
    for (const slot of await db.collection("merchant_slots").find({}).toArray()) {
      const startsAt = new Date(Date.now() + 86400000);
      await db.collection("merchant_slots").updateOne({ _id: slot._id }, { $set: { startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 8 * 3600000).toISOString() } });
    }
    const agents = new Map(await Promise.all(DEMO_MERCHANTS.map(async m => [m.id as string, await factory.createFromAgentCard(getMerchantAgentCard(m.id, origin))] as const)));
    await t.test("administrator-approved single-use bindings and unauthorized users", async () => {
      const unbound = { id: "unbound", merchantId: "demo-prius-parts", chatId: "99999", userId: "99999", mode: "demo" as const, active: true };
      await runtime.processUpdate(message(unbound, "Гупер 640 мянга, бэлэн"));
      assert.match(sent.at(-1)!.text, /Хандалтын эрхгүй/);
      for (const [index, merchant] of DEMO_MERCHANTS.entries()) {
        const id = String(10001 + index), invite = await store.issueInvite(merchant.id, id, "demo", "isolated-admin");
        await runtime.processUpdate(message({ ...unbound, chatId: id, userId: id }, `/start ${invite.token}`));
        const bound = await store.getBinding(id, id, "demo"); assert.ok(bound); assert.equal(bound.merchantId, merchant.id);
        bindings.set(merchant.id, bound);
        await assert.rejects(store.bind(invite.token, id, id, "demo"));
        const saved = await db.collection("merchant_telegram_invites").findOne({ id: invite.id });
        assert.ok(saved && !JSON.stringify(saved).includes(invite.token));
      }
    });
    await t.test("automatic A2A quotes commit one durable notification per RFQ and route all five merchants", async () => {
      for (const merchant of DEMO_MERCHANTS) {
        const input = envelope(merchant.id, `initial-${merchant.id}`, merchant.kind);
        assert.equal((await sendMerchantRFQ(agents.get(merchant.id)!, input)).outcome, "quoted");
        await sendMerchantRFQ(agents.get(merchant.id)!, input);
        assert.equal(await db.collection("merchant_telegram_notifications").countDocuments({ merchantId: merchant.id, rfqId: input.rfq.id }), 1);
      }
      await runtime.flushNotifications();
      for (const merchant of DEMO_MERCHANTS) {
        const notification = await db.collection("merchant_telegram_notifications").findOne({ merchantId: merchant.id });
        assert.equal(notification!.status, "sent"); assert.equal(notification!.chatId, bindings.get(merchant.id)!.chatId);
        const outgoing = sent.find(s => s.message_id === notification!.messageId)!;
        assert.ok(outgoing.text.includes(notification!.rfqId)); assert.ok(!outgoing.text.includes(buyerId));
        assert.match(outgoing.buttons!.inline_keyboard[0][0].text, /Хариу өгөх/);
        assert.ok(!/minimumPrice|maxDiscountBps/.test(outgoing.text));
      }
    });
    const parts = bindings.get("demo-prius-parts")!, rfqId = "initial-demo-prius-parts";
    await t.test("Mongolian draft review, duplicate updates, explicit webhook confirmation and genuine A2A delivery", async () => {
      const selected = await db.collection("merchant_telegram_notifications").findOne({ merchantId: parts.merchantId, rfqId });
      await runtime.processUpdate(callback(parts, `a:${selected!.id}`));
      outputs.push(draft(parts.merchantId));
      const incoming = message(parts, "Урд гупер 640 мянган төгрөг, үйлдвэрийн бус шинэ, одоо бэлэн.");
      await runtime.processUpdate(incoming);
      const calls = extractionCalls, sends = sent.length; await runtime.processUpdate(incoming);
      assert.equal(extractionCalls, calls); assert.equal(sent.length, sends);
      const record = await db.collection("merchant_telegram_drafts").findOne({ merchantId: parts.merchantId, rfqId, status: "review" });
      assert.ok(record); assert.equal(await db.collection("merchant_quote_publications").countDocuments({ rfqId }), 0);
      assert.equal((await sendQuoteUpdates(agents.get(parts.merchantId)!, rfqId)).quotes[0].source, "automatic");
      assert.match(sent.at(-1)!.text, /НООРОГ/); assert.match(sent.at(-1)!.text, /Баталгаа/);
      const confirm = callback(parts, `c:${record.id}`); expiredAck = true;
      const request = () => new Request(webhookConfig.webhookUrl, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": webhookConfig.webhookSecret }, body: JSON.stringify(confirm) });
      assert.equal((await handleTelegramWebhook(request(), { config: webhookConfig, db, runtime })).status, 200);
      assert.equal((await handleTelegramWebhook(request(), { config: webhookConfig, db, runtime })).status, 200);
      const updates = await sendQuoteUpdates(agents.get(parts.merchantId)!, rfqId, 1);
      assert.equal(updates.latestRevision, 2); assert.equal(updates.quotes.length, 1); assert.equal(updates.quotes[0].source, "human_confirmed");
      assert.equal(updates.quotes[0].quote.total.amountMinor, 64000000); assert.equal(updates.quotes[0].quote.reservation, false);
      assert.equal(await db.collection("merchant_quotes").countDocuments({ rfqId, revision: 2 }), 1);
      assert.equal(await db.collection("merchant_audit_events").countDocuments({ entityId: record.id, action: "telegram_draft_confirmed" }), 1);
      await Promise.all(Array.from({ length: 4 }, () => store.confirmDraft(parts, record.id, () => { throw new Error("Must replay published quote"); })));
      assert.equal(await db.collection("merchant_quote_publications").countDocuments({ rfqId }), 1);
      assert.equal((await db.collection("merchant_inventory").findOne({ merchantId: parts.merchantId, id: `${parts.merchantId}-bumper` }))!.stock, 5);
    });
    await t.test("cross-merchant Telegram callbacks and unauthorized Buyer quote reads are rejected", async () => {
      const published = await db.collection("merchant_telegram_drafts").findOne({ merchantId: parts.merchantId, rfqId });
      await runtime.processUpdate(callback(bindings.get("demo-japan-used")!, `c:${published!.id}`));
      assert.match(sent.at(-1)!.text, /олдсонгүй|эрхгүй/);
      assert.equal(await db.collection("merchant_quote_publications").countDocuments({ rfqId }), 1);
      await assert.rejects(store.getQuoteUpdates(parts.merchantId, "wrong-buyer", rfqId, 0));
      await assert.rejects(sendQuoteUpdates(agents.get("demo-japan-used")!, rfqId));
      const wrongFactory = factoryFor("wrong-buyer");
      // A valid credential for another buyer still cannot read this request's quote history.
      const wrongClient = await wrongFactory.createFromAgentCard(getMerchantAgentCard(parts.merchantId, origin));
      await assert.rejects(sendQuoteUpdates(wrongClient, rfqId));
    });
    await t.test("missing fields clarify, rejection persists, and an older draft reply uses its own RFQ", async () => {
      const newRFQ = envelope(parts.merchantId, "second-parts"); await sendMerchantRFQ(agents.get(parts.merchantId)!, newRFQ); await runtime.flushNotifications();
      const record = await newDraft(parts, "second-parts", { ...draft(parts.merchantId), lines: [{ ...draft(parts.merchantId).lines[0], unitPrice: null }] });
      assert.match(sent.at(-1)!.text, /Тодруулах мэдээлэл/);
      assert.ok(!sent.at(-1)!.buttons!.inline_keyboard[0].some(button => button.text === "Баталгаажуулах"));
      const previewId = sent.at(-1)!.message_id;
      const original = await db.collection("merchant_telegram_notifications").findOne({ merchantId: parts.merchantId, rfqId });
      await runtime.processUpdate(callback(parts, `a:${original!.id}`));
      outputs.push(draft(parts.merchantId));
      await runtime.processUpdate(message(parts, "Зассан санал 640 мянга, үйлдвэрийн бус шинэ, бэлэн.", previewId));
      const edited = await db.collection("merchant_telegram_drafts").findOne({ merchantId: parts.merchantId, rfqId: "second-parts", status: "review" });
      assert.ok(edited && edited.id !== record.id);
      await runtime.processUpdate(callback(parts, `r:${edited.id}`));
      assert.equal((await db.collection("merchant_telegram_drafts").findOne({ id: edited.id }))!.status, "rejected");
      assert.equal(await db.collection("merchant_quote_publications").countDocuments({ rfqId: "second-parts" }), 0);
    });
    await t.test("large RFQs and drafts show every line before the only confirmation button", async () => {
      const request = envelope(parts.merchantId, "large-human");
      request.rfq.items = Array.from({ length: 100 }, (_, index) => ({ description: `Урд гупер — мөр ${index + 1} · Тоёота Приус 30-д тохирох үйлдвэрийн бус шинэ сэлбэг`, quantity: 1 }));
      await sendMerchantRFQ(agents.get(parts.merchantId)!, request); await runtime.flushNotifications();
      const notification = await db.collection("merchant_telegram_notifications").findOne({ merchantId: parts.merchantId, rfqId: request.rfq.id });
      assert.ok(notification);
      const selectionStart = sent.length;
      await runtime.processUpdate(callback(parts, `a:${notification.id}`));
      const selected = sent.slice(selectionStart);
      assert.ok(selected.length > 1); assert.match(selected.map(message => message.text).join(""), /Урд гупер — мөр 100/);
      const complete: QuoteDraft = { ...draft(parts.merchantId), lines: Array.from({ length: 100 }, (_, index) => ({
        ...draft(parts.merchantId).lines[0], itemIndex: index,
        unitPrice: { amountMinor: index === 99 ? 65432100 : 64000000, currency: "MNT" },
      })) };
      outputs.push(complete);
      const previewStart = sent.length;
      await runtime.processUpdate(message(parts, "Бүх мөрийн үнэ, үйлдвэрийн бус шинэ, бэлэн."));
      const preview = sent.slice(previewStart);
      assert.ok(preview.length > 1); assert.match(preview.map(message => message.text).join(""), /654321 төгрөг/);
      for (const message of [...selected, ...preview]) {
        assert.ok(message.text.length <= 4000);
        assert.equal(await db.collection("merchant_telegram_message_links").countDocuments({ merchantId: parts.merchantId,
          bindingId: parts.id, messageId: message.message_id, rfqId: request.rfq.id }), 1);
      }
      assert.ok(preview.slice(0, -1).every(message => !message.buttons));
      assert.equal(preview.at(-1)!.buttons?.inline_keyboard.flat().filter(button => button.text === "Баталгаажуулах").length, 1);
      assert.equal(await db.collection("merchant_quote_publications").countDocuments({ rfqId: request.rfq.id }), 0);
    });
    await t.test("late confirmation and changed stock cannot publish; conversations survive failed extraction", async () => {
      for (const id of ["expired-human", "stock-human", "bad-extraction"]) await sendMerchantRFQ(agents.get(parts.merchantId)!, envelope(parts.merchantId, id));
      await runtime.flushNotifications();
      const expired = await newDraft(parts, "expired-human", draft(parts.merchantId));
      await db.collection("merchant_rfq_processing").updateOne({ merchantId: parts.merchantId, id: "expired-human" }, { $set: { "envelope.expiresAt": new Date(Date.now() - 1).toISOString() } });
      await runtime.processUpdate(callback(parts, `c:${expired.id}`)); assert.match(sent.at(-1)!.text, /хугацаа дууссан/);
      const stock = await newDraft(parts, "stock-human", draft(parts.merchantId));
      await db.collection("merchant_inventory").updateOne({ merchantId: parts.merchantId, id: `${parts.merchantId}-bumper` }, { $set: { stock: 0 } });
      await runtime.processUpdate(callback(parts, `c:${stock.id}`)); assert.match(sent.at(-1)!.text, /нөхцөл/);
      assert.equal(await db.collection("merchant_quote_publications").countDocuments({ rfqId: { $in: ["expired-human", "stock-human"] } }), 0);
      const notification = await db.collection("merchant_telegram_notifications").findOne({ merchantId: parts.merchantId, rfqId: "bad-extraction" });
      await runtime.processUpdate(callback(parts, `a:${notification!.id}`));
      const incoming = message(parts, "Тодорхой бус хариу"); await runtime.processUpdate(incoming);
      assert.match(sent.at(-1)!.text, /таних боломжгүй/);
      const conversation = await db.collection("merchant_telegram_conversations").findOne({ merchantId: parts.merchantId, updateId: incoming.update_id });
      assert.ok(conversation?.expiresAt instanceof Date); assert.equal(conversation!.text, "Тодорхой бус хариу");
    });
    await t.test("repair publication preserves selected actual service window; unavailable slots reject", async () => {
      const repair = bindings.get("demo-auto-care")!, id = "initial-demo-auto-care";
      const slot = await db.collection("merchant_slots").findOne({ merchantId: repair.merchantId });
      const repairDraft: QuoteDraft = { lines: [{ itemIndex: 0, resourceId: `${repair.merchantId}-service-0`, quantity: 1,
        unitPrice: { amountMinor: 14700000, currency: "MNT" }, condition: null, available: true, warranty: null }], slotId: slot!.id };
      const record = await newDraft(repair, id, repairDraft);
      await runtime.processUpdate(callback(repair, `c:${record.id}`));
      const updates = await sendQuoteUpdates(agents.get(repair.merchantId)!, id, 1);
      assert.equal(updates.quotes[0].source, "human_confirmed");
      assert.deepEqual(updates.quotes[0].serviceWindow, { startsAt: slot!.startsAt, endsAt: slot!.endsAt });
      await sendMerchantRFQ(agents.get(repair.merchantId)!, envelope(repair.merchantId, "repair-slot-change", "repair")); await runtime.flushNotifications();
      const blocked = await newDraft(repair, "repair-slot-change", repairDraft);
      await db.collection("merchant_slots").updateOne({ merchantId: repair.merchantId, id: slot!.id }, { $set: { status: "blocked" } });
      await runtime.processUpdate(callback(repair, `c:${blocked.id}`));
      assert.equal(await db.collection("merchant_quote_publications").countDocuments({ rfqId: "repair-slot-change" }), 0);
    });
    await t.test("real Mongo lease prevents second polling worker and in-flight webhook transport switches", async () => {
      await acquireTelegramLease(db, config, "worker-one");
      await assert.rejects(acquireTelegramLease(db, config, "worker-two"));
      await releaseTelegramLease(db, config, "worker-one");
      await withTelegramWebhookLease(db, webhookConfig, async () => { await assert.rejects(acquireTelegramLease(db, config, "worker-two")); });
      await acquireTelegramLease(db, config, "worker-two"); await releaseTelegramLease(db, config, "worker-two");
    });
    await t.test("binding revocation prevents further human actions", async () => {
      await store.revokeBinding(parts.id, "isolated-admin");
      assert.equal(await store.getBinding(parts.chatId, parts.userId, "demo"), null);
      await runtime.processUpdate(message(parts, "Гупер 640 мянга, бэлэн")); assert.match(sent.at(-1)!.text, /Хандалтын эрхгүй/);
      assert.equal(await db.collection("merchant_telegram_bindings").countDocuments({ id: parts.id, active: true }), 0);
    });
  } finally { await client.close(); await replica.stop(); }
});
