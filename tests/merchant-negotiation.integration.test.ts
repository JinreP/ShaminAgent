import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoRFQStore } from "../merchant/a2a/store";
import { calculateMerchantRFQ } from "../merchant/a2a/engine";
import { createMerchantRFQProcessor } from "../merchant/a2a/service";
import type { MerchantRFQEnvelope } from "../merchant/a2a/contracts";
import { seedDemoMerchants } from "../merchant/server/seed";
import { createTelegramRuntime } from "../merchant/telegram/service";
import { readTelegramConfig } from "../merchant/telegram/config";
import { TelegramMerchantStore } from "../merchant/telegram/store";
import type { TelegramAPI, InlineKeyboard } from "../merchant/telegram/api";
import type { AIProvider } from "../merchant/server/providers";
import type { TelegramBinding, TelegramUpdate } from "../merchant/telegram/contracts";
import { NegotiationStore } from "../merchant/negotiation/store";
import { getNegotiationResultRequestSchema, negotiateQuoteRequestSchema, negotiationResponseSchema,
  type NegotiationRequest } from "../merchant/negotiation/contracts";

test("merchant negotiations persist atomically in disposable MongoDB with mocked Telegram", {
  skip: process.env.MERCHANT_NEGOTIATION_LOCAL_INTEGRATION !== "true", timeout: 600000,
}, async t => {
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger", ip: "127.0.0.1" } });
  const client = new MongoClient(replica.getUri()), db = client.db("merchant_phase5_disposable");
  const buyerId = "phase5-isolated-buyer", merchantId = "demo-prius-parts";
  const config = readTelegramConfig({ NODE_ENV: "test", MERCHANT_TELEGRAM_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz_test_token", MERCHANT_TELEGRAM_AUTH_MODE: "demo",
    MERCHANT_TELEGRAM_DEMO_ENABLED: "true" });
  const sent: { chatId: string; text: string; buttons?: InlineKeyboard }[] = [];
  let messageId = 0, updateId = 100;
  const telegram: TelegramAPI = {
    async sendMessage(chatId, text, buttons) { sent.push({ chatId, text, buttons }); return { message_id: ++messageId }; },
    async answerCallbackQuery() {},
    async getMe() { return { id: 123456, is_bot: true }; },
    async deleteWebhook() {}, async setWebhook() {},
    async getUpdates() { return []; },
    async getWebhookInfo() { return { url: "", pending_update_count: 0 }; },
  };
  const ai: AIProvider = { async generate() { throw new Error("Negotiation must not invoke an AI provider"); } };
  const processor = createMerchantRFQProcessor(async () => ({ client, db }));
  const negotiate = async (scopedMerchantId: string, scopedBuyerId: string, input: unknown) =>
    negotiationResponseSchema.parse(await processor(scopedMerchantId, scopedBuyerId, input));
  const telegramStore = new TelegramMerchantStore(client, db);
  const runtime = createTelegramRuntime({ client, db, telegram, ai, config });
  function envelope(id: string, kind: "parts" | "repair" = "parts"): MerchantRFQEnvelope {
    return { contractVersion: "1", correlationId: `corr-${id}`, expiresAt: new Date(Date.now() + 3600000).toISOString(),
      rfq: { contractVersion: "1", id, merchantId: kind === "parts" ? merchantId : "demo-auto-care", buyerId,
        createdAt: new Date(Date.now() - 1000).toISOString(), kind,
        vehicle: { make: "Toyota", model: "Prius 30", year: 2012 },
        items: [{ description: kind === "parts" ? "Урд гупер" : "Гупер солих", quantity: 1 }], status: "received" } };
  }
  async function quoteFor(id: string, kind: "parts" | "repair" = "parts") {
    const input = envelope(id, kind), scopedMerchant = input.rfq.merchantId;
    if (kind === "repair") {
      for (const slot of await db.collection("merchant_slots").find({ merchantId: scopedMerchant }).toArray()) {
        const start = new Date(Date.now() + 86400000);
        await db.collection("merchant_slots").updateOne({ merchantId: scopedMerchant, id: slot.id }, {
          $set: { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 8 * 3600000).toISOString() },
        });
      }
    }
    const response = await new MongoRFQStore(client, db).processOnce(scopedMerchant, buyerId, input,
      (data, now) => calculateMerchantRFQ(scopedMerchant, input, data, now));
    assert.ok(response.quote);
    return { input, quote: response.quote };
  }
  function request(input: MerchantRFQEnvelope, quote: NonNullable<Awaited<ReturnType<typeof quoteFor>>["quote"]>,
    id: string, totalMnt: number, expiresInMs = 600000): NegotiationRequest {
    return negotiateQuoteRequestSchema.parse({ contractVersion: "1", action: "negotiate_quote",
      rfqId: input.rfq.id, correlationId: input.correlationId,
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      negotiation: { contractVersion: "1", id, merchantId: input.rfq.merchantId, buyerId,
        createdAt: new Date(Date.now() - 1000).toISOString(), quoteId: quote.id, quoteRevision: quote.revision,
        requestedTotal: { amountMinor: totalMnt * 100, currency: "MNT" }, status: "requested" } });
  }
  async function setPolicy(id: string, patch: Record<string, unknown>) {
    await db.collection("merchant_settings").updateOne({ merchantId: id, id }, { $set: patch });
  }
  async function register(merchant: string): Promise<TelegramBinding> {
    const telegramId = merchant === merchantId ? "50101" : "50102";
    const invite = await telegramStore.issueInvite(merchant, telegramId, "demo", "phase5-admin");
    return telegramStore.bind(invite.token, telegramId, telegramId, "demo");
  }
  function callback(binding: TelegramBinding, data: string): TelegramUpdate {
    return { update_id: ++updateId, callback_query: { id: `callback-${updateId}`,
      from: { id: Number(binding.userId) }, data,
      message: { message_id: 1, chat: { id: Number(binding.chatId), type: "private" } } } };
  }
  function message(binding: TelegramBinding, text: string): TelegramUpdate {
    return { update_id: ++updateId, message: { message_id: updateId, from: { id: Number(binding.userId) },
      chat: { id: Number(binding.chatId), type: "private" }, text } };
  }
  try {
    await client.connect();
    await seedDemoMerchants(client, db);
    const partsBinding = await register(merchantId);
    const repairBinding = await register("demo-auto-care");
    const resultAction = (rfqId: string, negotiationId: string) => getNegotiationResultRequestSchema.parse({
      contractVersion: "1", action: "get_negotiation_result", rfqId, negotiationId });

    await t.test("automatically accepts a permitted whole-MNT offer and publishes a new quote revision", async () => {
      await setPolicy(merchantId, { humanApprovalRequired: false, automaticNegotiationEnabled: true });
      const { input, quote } = await quoteFor("phase5-auto-accept");
      const offer = request(input, quote, "neg-phase5-auto-accept", 640000);
      const result = await negotiate(merchantId, buyerId, offer);
      assert.equal(result.outcome, "accepted");
      assert.equal(result.quote?.revision, quote.revision + 1);
      assert.equal(result.quote?.total.amountMinor, 64000000);
      assert.equal(result.quote?.reservation, false);
      assert.deepEqual(negotiationResponseSchema.parse(result), result);
      const history = await db.collection("merchant_quotes").find({ merchantId, rfqId: input.rfq.id }).sort({ revision: 1 }).toArray();
      assert.deepEqual(history.map(record => record.status), ["superseded", "offered"]);
      const update = await processor(merchantId, buyerId, { contractVersion: "1", action: "get_quote_updates",
        rfqId: input.rfq.id, afterRevision: 1 });
      assert.equal("quotes" in update && update.quotes[0]?.source, "negotiated");
      assert.ok(!JSON.stringify(result).includes("minimumPrice"));
    });

    await t.test("private price floors produce a counteroffer and discount limits cannot be overridden", async () => {
      const { input, quote } = await quoteFor("phase5-minimum-counter");
      const result = await negotiate(merchantId, buyerId, request(input, quote, "neg-phase5-minimum-counter", 250000));
      assert.equal(result.outcome, "countered");
      assert.equal(result.quote?.total.amountMinor, 62400000);
      assert.equal(result.quote?.total.currency, "MNT");
      assert.ok(!JSON.stringify(result).includes("minimumPrice"));
    });

    await t.test("disabled rules, stale revisions, expiration, unauthorized and duplicate requests are rejected safely", async () => {
      const disabled = await quoteFor("phase5-disabled");
      await setPolicy(merchantId, { negotiationEnabled: false, humanApprovalRequired: false, automaticNegotiationEnabled: true });
      const disabledResult = await negotiate(merchantId, buyerId, request(disabled.input, disabled.quote, "neg-phase5-disabled", 640000));
      assert.equal(disabledResult.outcome, "rejected"); assert.equal(disabledResult.code, "negotiation_disabled");
      await setPolicy(merchantId, { negotiationEnabled: true, maxNegotiationRounds: 1 });

      const stale = await quoteFor("phase5-stale");
      const first = request(stale.input, stale.quote, "neg-phase5-stale-first", 600000);
      const committed = await negotiate(merchantId, buyerId, first);
      assert.equal(committed.outcome, "countered");
      const duplicate = await negotiate(merchantId, buyerId, first);
      assert.deepEqual(duplicate, committed);
      const changedDuplicate = { ...first, negotiation: { ...first.negotiation, requestedTotal: { amountMinor: 63000000, currency: "MNT" } } };
      await assert.rejects(processor(merchantId, buyerId, changedDuplicate));
      const staleResult = await negotiate(merchantId, buyerId, request(stale.input, stale.quote, "neg-phase5-stale-second", 630000));
      assert.equal(staleResult.outcome, "rejected"); assert.equal(staleResult.code, "stale_quote");

      const expired = await quoteFor("phase5-expired");
      await db.collection("merchant_quotes").updateOne({ merchantId, id: expired.quote.id },
        { $set: { expiresAt: new Date(Date.parse(expired.quote.createdAt) + 1).toISOString() } });
      const expiredResult = await negotiate(merchantId, buyerId, request(expired.input, expired.quote, "neg-phase5-expired", 640000));
      assert.equal(expiredResult.outcome, "rejected"); assert.equal(expiredResult.code, "quote_expired");
      const expiredRFQ = await quoteFor("phase5-expired-rfq");
      const rfqProcessing = await db.collection("merchant_rfq_processing").findOne({ merchantId, id: expiredRFQ.input.rfq.id });
      assert.ok(rfqProcessing);
      await db.collection("merchant_rfq_processing").updateOne({ merchantId, id: expiredRFQ.input.rfq.id },
        { $set: { "envelope.expiresAt": new Date(Date.parse(expiredRFQ.input.rfq.createdAt) + 1).toISOString() } });
      const expiredRFQResult = await negotiate(merchantId, buyerId,
        request(expiredRFQ.input, expiredRFQ.quote, "neg-phase5-expired-rfq-negotiation", 640000));
      assert.equal(expiredRFQResult.outcome, "rejected"); assert.equal(expiredRFQResult.code, "rfq_expired");
      const unauthorized = request(disabled.input, disabled.quote, "neg-phase5-unauthorized", 640000);
      await assert.rejects(processor(merchantId, "other-buyer", unauthorized));
    });

    await t.test("maximum negotiation rounds and concurrent requests cannot publish conflicting quote versions", async () => {
      await setPolicy(merchantId, { negotiationEnabled: true, humanApprovalRequired: false, automaticNegotiationEnabled: true, maxNegotiationRounds: 1 });
      const { input, quote } = await quoteFor("phase5-round-limit");
      const first = await negotiate(merchantId, buyerId, request(input, quote, "neg-phase5-round-one", 600000));
      assert.equal(first.outcome, "countered");
      const second = await negotiate(merchantId, buyerId, request(input, first.quote!, "neg-phase5-round-two", 600000));
      assert.equal(second.outcome, "rejected"); assert.equal(second.code, "round_limit");

      await setPolicy(merchantId, { maxNegotiationRounds: 3 });
      const concurrent = await quoteFor("phase5-concurrent");
      const results = await Promise.all([
        negotiate(merchantId, buyerId, request(concurrent.input, concurrent.quote, "neg-phase5-concurrent-a", 640000)),
        negotiate(merchantId, buyerId, request(concurrent.input, concurrent.quote, "neg-phase5-concurrent-b", 630000)),
      ]);
      assert.equal(results.filter(result => result.outcome === "accepted" || result.outcome === "countered").length, 1);
      assert.ok(results.some(result => result.code === "stale_quote" || result.code === "negotiation_pending"));
      const versions = await db.collection("merchant_quotes").find({ merchantId, rfqId: concurrent.input.rfq.id }).toArray();
      assert.equal(versions.length, 2);
      assert.equal(versions.filter(quote => quote.status === "offered").length, 1);
    });

    await t.test("human approval, rejection, counteroffer, timeout, and repair negotiation use Mongolian Telegram copy", async () => {
      await setPolicy(merchantId, { negotiationEnabled: true, humanApprovalRequired: true,
        automaticNegotiationEnabled: false, maxNegotiationRounds: 5 });
      const approval = await quoteFor("phase5-telegram-approve");
      const approvalPending = await negotiate(merchantId, buyerId, request(approval.input, approval.quote,
        "neg-phase5-telegram-approve", 640000));
      assert.equal(approvalPending.outcome, "pending");
      await runtime.flushNotifications();
      const approvalRecord = await db.collection("merchant_negotiation_processing")
        .findOne({ merchantId, id: "neg-phase5-telegram-approve" });
      assert.ok(approvalRecord?.telegramHandle);
      await runtime.processUpdate(callback(partsBinding, `na:${approvalRecord.telegramHandle}`));
      const accepted = await negotiate(merchantId, buyerId, resultAction(approval.input.rfq.id, "neg-phase5-telegram-approve"));
      assert.equal(accepted.outcome, "accepted"); assert.equal(accepted.quote?.total.amountMinor, 64000000);

      const { input, quote } = await quoteFor("phase5-telegram-reject");
      const pending = await negotiate(merchantId, buyerId, request(input, quote, "neg-phase5-telegram-reject", 640000));
      assert.equal(pending.outcome, "pending");
      await runtime.flushNotifications();
      const processing = await db.collection("merchant_negotiation_processing").findOne({ merchantId, id: "neg-phase5-telegram-reject" });
      const sentMessage = sent.find(item => item.text.includes("neg-phase5-telegram-reject"));
      assert.ok(processing?.notificationBindingId === partsBinding.id);
      assert.ok(sentMessage);
      assert.match(sentMessage.text, /Зөвшөөрөх/);
      const buttonLabels = sentMessage.buttons?.inline_keyboard[0]?.map(button => button.text) ?? [];
      assert.deepEqual(buttonLabels, ["Зөвшөөрөх", "Өөр үнэ санал болгох", "Татгалзах"]);
      assert.match(sentMessage.text, /[\u0400-\u04ff]/u);
      assert.ok(!/minimumPrice|maxDiscountBps/.test(sentMessage.text));
      const handle = processing.telegramHandle as string;
      await assert.rejects(new NegotiationStore(client, db).getHumanContext(repairBinding, handle));
      const rejectCallback = callback(partsBinding, `nr:${handle}`);
      await runtime.processUpdate(rejectCallback);
      await runtime.processUpdate(rejectCallback);
      assert.equal(await db.collection("merchant_telegram_negotiation_events")
        .countDocuments({ negotiationId: "neg-phase5-telegram-reject", action: "rejected" }), 1);
      const rejected = await negotiate(merchantId, buyerId, resultAction(input.rfq.id, "neg-phase5-telegram-reject"));
      assert.equal(rejected.outcome, "rejected"); assert.equal(rejected.code, "merchant_rejected");

      const { input: counterInput, quote: counterQuote } = await quoteFor("phase5-telegram-counter");
      const counterPending = await negotiate(merchantId, buyerId, request(counterInput, counterQuote,
        "neg-phase5-telegram-counter", 620000));
      assert.equal(counterPending.outcome, "pending");
      await runtime.flushNotifications();
      const counterRecord = await db.collection("merchant_negotiation_processing")
        .findOne({ merchantId, id: "neg-phase5-telegram-counter" });
      assert.ok(counterRecord?.telegramHandle);
      await runtime.processUpdate(callback(partsBinding, `nc:${counterRecord.telegramHandle}`));
      await runtime.processUpdate(message(partsBinding, "640000 төгрөг"));
      const draftRecord = await db.collection("merchant_negotiation_processing")
        .findOne({ merchantId, id: "neg-phase5-telegram-counter" });
      assert.equal(draftRecord?.counterDraft?.total.amountMinor, 64000000);
      await runtime.processUpdate(callback(partsBinding, `nx:${counterRecord.telegramHandle}:${draftRecord?.counterDraft?.updateId}`));
      const countered = await negotiate(merchantId, buyerId, resultAction(counterInput.rfq.id, "neg-phase5-telegram-counter"));
      assert.equal(countered.outcome, "countered"); assert.equal(countered.quote?.total.amountMinor, 64000000);
      assert.ok(await db.collection("merchant_telegram_negotiation_events").countDocuments({ negotiationId: "neg-phase5-telegram-counter" }) >= 2);

      await setPolicy("demo-auto-care", { negotiationEnabled: true, humanApprovalRequired: false,
        automaticNegotiationEnabled: true, maxNegotiationRounds: 5 });
      const repair = await quoteFor("phase5-repair", "repair");
      const repairResult = await negotiate("demo-auto-care", buyerId, request(repair.input, repair.quote, "neg-phase5-repair", 145000));
      assert.ok(repairResult.outcome === "accepted" || repairResult.outcome === "countered");
      assert.equal(repairResult.quote?.kind, "repair");
      assert.equal(repairResult.quote?.reservation, false);

      const timeoutOffer = await negotiate(merchantId, buyerId, request(counterInput, countered.quote!, "neg-phase5-timeout", 620000));
      assert.equal(timeoutOffer.outcome, "pending");
      await db.collection("merchant_negotiation_processing").updateOne({ merchantId, id: "neg-phase5-timeout" },
        { $set: { expiresAt: new Date(Date.now() - 1).toISOString() } });
      const timeoutResult = await negotiate(merchantId, buyerId, resultAction(counterInput.rfq.id, "neg-phase5-timeout"));
      assert.equal(timeoutResult.outcome, "rejected"); assert.equal(timeoutResult.code, "merchant_timeout");
      assert.ok(repairBinding.active);
    });
  } finally {
    await client.close();
    await replica.stop();
  }
});
