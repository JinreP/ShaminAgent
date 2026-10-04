import "server-only";
import { randomUUID } from "node:crypto";
import type { Db, MongoClient } from "mongodb";
import { auditEventSchema, idSchema } from "../../shared/merchant-contracts";
import { merchantRFQEnvelopeSchema, type MerchantRFQEnvelope } from "../a2a/contracts";
import { getMerchantClient, getMerchantDb } from "../server/database";
import { createAIProvider, type AIProvider } from "../server/providers";
import { readMerchantEnv } from "../server/env";
import { localizeKnownText, merchantName, statusLabel } from "../i18n";
import { TelegramBotAPI, TelegramAPIError, type TelegramAPI, type InlineKeyboard } from "./api";
import { readTelegramConfig, type TelegramConfig } from "./config";
import { telegramUpdateSchema, type TelegramUpdate, type TelegramBinding, type DraftRecord } from "./contracts";
import { TelegramMerchantStore, TelegramStoreError } from "./store";
import { extractQuoteDraft, missingDraftFields, QuoteExtractionError } from "./extraction";
import { HumanQuoteError, validateHumanQuote } from "./validation";
import { NegotiationStore, NegotiationStoreError } from "../negotiation/store";
import { NegotiationRuleError } from "../negotiation/engine";
import { createNegotiationTelegram, type NegotiationLink } from "./negotiation";

type Dependencies = { client: MongoClient; db: Db; telegram: TelegramAPI; ai: AIProvider; config: TelegramConfig };
const callbackButtons = (draft: DraftRecord, ready: boolean): InlineKeyboard => ({ inline_keyboard: [
  [...(ready ? [{ text: "Баталгаажуулах", callback_data: `c:${draft.id}` }] : []),
    { text: "Засах", callback_data: `e:${draft.id}` }, { text: "Татгалзах", callback_data: `r:${draft.id}` }],
] });
function safeError(error: unknown): string {
  return error instanceof HumanQuoteError || error instanceof TelegramStoreError || error instanceof TelegramAPIError || error instanceof QuoteExtractionError ||
    error instanceof NegotiationStoreError || error instanceof NegotiationRuleError ? error.message :
    "Хүсэлтийг боловсруулах боломжгүй байна. Түр хүлээгээд дахин оролдоно уу.";
}
export function formatRFQNotification(envelope: MerchantRFQEnvelope, full = false): string {
  const rfq = envelope.rfq;
  const model = /prius|приус/i.test(rfq.vehicle.model) ? `Тоёота Приус ${/30/.test(rfq.vehicle.model) ? "30" : ""}`.trim() : "Автомашины хүсэлт";
  const items = rfq.items.slice(0, full ? 100 : 10).map(item => `${localizeKnownText(item.description, rfq.kind === "parts" ? "Хүссэн сэлбэг" : "Хүссэн засвар").slice(0, full ? 500 : 160)} · ${item.quantity} ширхэг${item.preference ? ` · ${statusLabel(item.preference)}` : ""}${item.partNumber ? ` · Сэлбэгийн дугаар: ${item.partNumber}` : ""}`);
  return `Шинэ үнийн саналын хүсэлт ирлээ.\n\n${merchantName(rfq.merchantId)}\nМашин: ${model}${rfq.vehicle.year ? ` (${rfq.vehicle.year})` : ""}\n${rfq.kind === "parts" ? "Сэлбэг" : "Засвар"}:\n${items.join("\n")}\n${!full && rfq.items.length > 10 ? `Бусад ${rfq.items.length - 10} мөр байна. Сонгох товчоор хүсэлтийг нээнэ үү.\n` : ""}Хүсэлтийн дугаар: ${rfq.id}\nХариу өгөх хугацаа: ${envelope.expiresAt}${rfq.requiredBy ? `\nШаардлагатай хугацаа: ${rfq.requiredBy}` : ""}\n\nХариу өгөх товчийг дарж, үнийн саналаа монгол кириллээр илгээнэ үү. Үнийг төгрөгөөр бичнэ. Баталгаажуулах хүртэл хүний саналыг нийтлэхгүй. Энэ нь бараа, засварын цаг захиалахгүй.`;
}

/** Telegram's message limit must never hide fields a merchant is about to confirm. */
function messageChunks(text: string): string[] {
  const chunks: string[] = [];
  while (text.length > 4000) {
    const newline = text.lastIndexOf("\n", 3999);
    let end = newline > 2000 ? newline + 1 : 4000;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(0, end)); text = text.slice(end);
  }
  if (text) chunks.push(text);
  return chunks;
}

export function createTelegramRuntime({ client, db, telegram, ai, config }: Dependencies) {
  const store = new TelegramMerchantStore(client, db);
  async function select(binding: TelegramBinding, rfqId: string) {
    const context = await store.getRFQContext(binding, rfqId);
    requireLiveRFQ(context.envelope);
    await db.collection("merchant_telegram_sessions").updateOne({ merchantId: binding.merchantId, bindingId: binding.id },
      { $set: { kind: "rfq", rfqId, correlationId: context.envelope.correlationId, chatId: binding.chatId, userId: binding.userId, updatedAt: new Date() },
        $unset: { negotiationHandle: "" } }, { upsert: true });
    return context;
  }
  async function reply(chatId: string, text: string, buttons?: InlineKeyboard) {
    const chunks = messageChunks(text);
    let sent: { message_id: number } | undefined;
    for (const [index, chunk] of chunks.entries()) sent = await telegram.sendMessage(chatId, chunk, index === chunks.length - 1 ? buttons : undefined);
    return sent!;
  }
  async function prompt(binding: TelegramBinding, rfqId: string, text: string, buttons?: InlineKeyboard, link?: NegotiationLink) {
    const chunks = messageChunks(text);
    for (const [index, chunk] of chunks.entries()) {
      const sent = await telegram.sendMessage(binding.chatId, chunk, index === chunks.length - 1 ? buttons : undefined);
      await db.collection("merchant_telegram_message_links").updateOne({ merchantId: binding.merchantId, bindingId: binding.id, messageId: sent.message_id },
        { $setOnInsert: { merchantId: binding.merchantId, bindingId: binding.id, chatId: binding.chatId, messageId: sent.message_id, rfqId, ...link,
          expiresAt: new Date(Date.now() + 30 * 86400000) } }, { upsert: true });
    }
  }
  async function acknowledge(id: string, text: string) {
    try { await telegram.answerCallbackQuery(id, text); }
    catch (error) {
      // Telegram rejects an expired callback acknowledgement. It must not block a validated business action.
      if (!(error instanceof TelegramAPIError) || error.code !== "rejected") throw error;
    }
  }
  const negotiation = createNegotiationTelegram({ store: new NegotiationStore(client, db), db, client, api: telegram, config,
    getBinding: (chatId, userId, mode) => store.getBinding(chatId, userId, mode), prompt, acknowledge });
  async function handle(update: TelegramUpdate) {
    const callback = update.callback_query;
    const chat = callback?.message?.chat ?? update.message?.chat;
    const user = callback?.from ?? update.message?.from;
    if (!chat || !user || user.is_bot || chat.type !== "private" || chat.id !== user.id) return;
    const chatId = String(chat.id), userId = String(user.id);
    let binding = await store.getBinding(chatId, userId, config.merchantAuthMode);
    const registration = /^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{32,128})$/.exec(update.message?.text ?? "");
    if (registration) {
      if (!binding) binding = await store.bind(registration[1], chatId, userId, config.merchantAuthMode);
      await reply(chatId, `Хандалтын эрх баталгаажлаа.\n${merchantName(binding.merchantId)}\nҮнийн саналын хүсэлт ирэхэд мэдэгдэл авна. Дуу хоолойн хариу одоогоор дэмжигдээгүй.`);
      return;
    }
    if (!binding) {
      if (callback) await acknowledge(callback.id, "Хандалтын эрхгүй байна.");
      await reply(chatId, "Хандалтын эрхгүй байна. Администратороос зөвхөн танд зориулсан бүртгэлийн холбоос авна уу.");
      return;
    }
    if (await negotiation.handle(binding, update)) return;
    if (callback) {
      const action = /^([acer]):([A-Za-z0-9_-]{1,60})$/.exec(callback.data ?? "");
      if (!action) { await acknowledge(callback.id, "Үйлдэл олдсонгүй."); return; }
      await acknowledge(callback.id, "Хүсэлтийг шалгаж байна.");
      const [, kind, id] = action;
      if (kind === "a") {
        const notification = await db.collection("merchant_telegram_notifications").findOne({ merchantId: binding.merchantId, id,
          bindingId: binding.id, chatId });
        if (!notification) throw new TelegramStoreError("Хүсэлт олдсонгүй эсвэл хандах эрхгүй байна.");
        const context = await select(binding, notification.rfqId);
        await prompt(binding, context.envelope.rfq.id, `${formatRFQNotification(context.envelope, true)}\n\nХүсэлт сонгогдлоо. Үнэ, сэлбэгийн төлөв, боломжийг бичнэ үү. Засвар бол боломжит цагийн дугаарыг бичнэ үү.`);
        if (context.envelope.rfq.kind === "repair") {
          const slots = context.data.slots.filter(slot => slot.status === "available" && Date.parse(slot.startsAt) > Date.now()).slice(0, 10);
          await prompt(binding, context.envelope.rfq.id, slots.length ? `Бүртгэлтэй боломжит цагууд:\n${slots.map(s => `${s.id}\n${s.startsAt} — ${s.endsAt}`).join("\n")}` : "Одоогоор боломжит засварын цаг алга байна.");
        }
        return;
      }
      const draft = await store.getDraft(binding, id);
      if (kind === "c") {
        const quote = await store.confirmDraft(binding, id, validateHumanQuote);
        await reply(chatId, `Хүний үнийн санал баталгаажиж хадгалагдлаа.\nХүсэлт: ${quote.rfqId}\nХувилбар: ${quote.revision}\nНийт: ${(quote.total.amountMinor / 100).toLocaleString("mn-MN")} төгрөг\nХудалдан авагч A2A шинэчлэлтээр саналыг авах боломжтой. Бараа, засварын цаг захиалаагүй.`);
      } else if (kind === "r") {
        await store.rejectDraft(binding, id);
        await reply(chatId, "Үнийн саналын нооргийг татгалзсан гэж хадгаллаа. Автомат хариу хэвээр байна.");
      } else {
        if (draft.status === "confirmed" || draft.status === "rejected") throw new TelegramStoreError("Энэ нооргийг дахин засах боломжгүй байна.");
        await select(binding, draft.rfqId);
        await db.collection("merchant_telegram_drafts").updateOne({ merchantId: binding.merchantId, bindingId: binding.id, id, status: "review" },
          { $set: { status: "superseded" } });
        await prompt(binding, draft.rfqId, `Хүсэлт: ${draft.rfqId}\nЗассан саналаа бүтнээр нь дахин бичнэ үү. Өмнөх нооргийн баталгаажуулалт хаагдсан.`);
      }
      return;
    }
    const text = update.message?.text;
    if (!text || text.startsWith("/")) {
      await reply(chatId, "Хүсэлтийн Хариу өгөх товчийг дарж, үнийн саналаа монгол кириллээр бичнэ үү. Дуу хоолой хараахан дэмжигдээгүй.");
      return;
    }
    let rfqId: string | undefined;
    if (update.message?.reply_to_message) {
      const notification = await db.collection("merchant_telegram_notifications").findOne({ merchantId: binding.merchantId, bindingId: binding.id,
        chatId, messageId: update.message.reply_to_message.message_id });
      rfqId = notification?.rfqId;
      if (!rfqId) rfqId = (await db.collection("merchant_telegram_message_links").findOne({ merchantId: binding.merchantId, bindingId: binding.id,
        chatId, messageId: update.message.reply_to_message.message_id }))?.rfqId;
      if (!rfqId) { await reply(chatId, "Хариулж буй мессежийн хүсэлт олдсонгүй. Хүсэлтээ Хариу өгөх товчоор дахин сонгоно уу."); return; }
    }
    if (!rfqId) rfqId = (await db.collection("merchant_telegram_sessions").findOne({ merchantId: binding.merchantId, bindingId: binding.id }))?.rfqId;
    if (!rfqId) { await reply(chatId, "Эхлээд хариу өгөх хүсэлтээ товчоор сонгоно уу."); return; }
    const context = await select(binding, idSchema.parse(rfqId));
    await store.recordConversation(binding, rfqId, text, update.update_id);
    // A failed Telegram send may retry this update after its draft committed. Do not ask AI to reinterpret it.
    const existing = await db.collection("merchant_telegram_drafts").findOne({ merchantId: binding.merchantId, bindingId: binding.id, telegramUpdateId: update.update_id });
    const draft = existing ? await store.getDraft(binding, existing.id) : await store.saveDraft(binding, rfqId,
      await extractQuoteDraft(ai, context.envelope.rfq, context.data, text), text, update.update_id);
    const extracted = draft.draft;
    const missing = missingDraftFields(extracted, context.envelope.rfq.kind);
    const resources = context.envelope.rfq.kind === "parts" ? context.data.inventory : context.data.services;
    const lines = extracted.lines.map(line => {
      const resource = resources.find(r => r.id === line.resourceId);
      return `${localizeKnownText(resource?.name ?? "", "Бараа, үйлчилгээг тодруулна уу.")}\nТоо: ${line.quantity ?? "Тодруулах"} · Үнэ: ${line.unitPrice ? `${line.unitPrice.amountMinor / 100} төгрөг` : "Тодруулах"}${line.condition ? ` · ${statusLabel(line.condition)}` : ""}\nБоломж: ${line.available === true ? "Боломжтой" : line.available === false ? "Боломжгүй" : "Тодруулах"}\nБаталгаа: ${localizeKnownText(resource?.warranty ?? "", "Худалдаачнаас тодруулна уу.")}${resource && "customerPartsTerms" in resource ? `\nЗахиалагчийн сэлбэг: ${localizeKnownText(resource.customerPartsTerms)}` : ""}`;
    });
    const slot = context.data.slots.find(s => s.id === extracted.slotId);
    const preview = `ХҮНИЙ ҮНИЙН САНАЛЫН НООРОГ\nХүсэлт: ${rfqId}\n${lines.join("\n\n")}${slot ? `\nЗасварын цаг: ${slot.startsAt} — ${slot.endsAt}` : ""}\n\n${missing.length ? `Тодруулах мэдээлэл: ${missing.join(", ")}. Саналаа бүтнээр нь дахин бичнэ үү.` : "Мэдээллээ шалгаад Баталгаажуулах товчийг дарна уу. Сервер бизнесийн дүрэм, бодит боломжийг дахин шалгана."}\nНоорог худалдан авагчид хараахан нийтлэгдээгүй.`;
    await prompt(binding, draft.rfqId, preview, draft.status === "review" ? callbackButtons(draft, missing.length === 0) : undefined);
  }
  async function processUpdate(input: TelegramUpdate): Promise<void> {
    const update = telegramUpdateSchema.parse(input);
    const lease = await store.claimUpdate(config.botKey, update.update_id);
    if (!lease) {
      const existing = await db.collection("merchant_telegram_updates").findOne({ botKey: config.botKey, updateId: update.update_id });
      if (existing?.status !== "done") throw new Error("Хүсэлт боловсруулагдаж байна. Дахин оролдоно уу.");
      return;
    }
    let lost = false, renewing = false;
    const heartbeat = setInterval(async () => {
      if (renewing || lost) return;
      renewing = true;
      try { if (!await store.renewUpdate(config.botKey, update.update_id, lease)) lost = true; }
      catch { lost = true; }
      finally { renewing = false; }
    }, 20000);
    heartbeat.unref();
    try {
      try { await handle(update); }
      catch (error) {
        // Expected validation failures are terminal for this update; network/database failures retry.
        if (!(error instanceof TelegramStoreError || error instanceof HumanQuoteError || error instanceof QuoteExtractionError ||
            error instanceof NegotiationStoreError || error instanceof NegotiationRuleError)) throw error;
        const chat = update.callback_query?.message?.chat ?? update.message?.chat;
        const user = update.callback_query?.from ?? update.message?.from;
        if (chat?.type === "private" && chat.id === user?.id) await reply(String(chat.id), safeError(error));
      }
      if (lost) throw new Error("Хүсэлтийг боловсруулах эзэмших эрх тасарлаа.");
      await store.completeUpdate(config.botKey, update.update_id, lease);
    } catch (error) {
      if (error instanceof TelegramAPIError && error.code === "rejected") {
        await db.collection("merchant_telegram_updates").updateOne({ botKey: config.botKey, updateId: update.update_id, leaseToken: lease },
          { $set: { deliveryStatus: "failed", deliveryReason: "telegram_rejected" } });
        await store.completeUpdate(config.botKey, update.update_id, lease);
        return;
      }
      await store.failUpdate(config.botKey, update.update_id, lease);
      if (error instanceof TelegramAPIError) throw error;
      throw new Error(safeError(error));
    } finally { clearInterval(heartbeat); }
  }
  async function flushNotifications(): Promise<void> {
    await negotiation.flush();
    for (let i = 0; i < 20; i++) {
      const now = new Date(), lease = randomUUID();
      const pending = await db.collection("merchant_telegram_notifications").findOneAndUpdate({ $or: [
        { status: "pending", nextAttemptAt: { $lte: now } }, { status: "sending", leaseUntil: { $lte: now } },
      ] }, { $set: { status: "sending", lease, leaseUntil: new Date(now.getTime() + 180000) }, $inc: { attempts: 1 } },
      { returnDocument: "after", sort: { nextAttemptAt: 1 } });
      if (!pending) return;
      const scope = { merchantId: pending.merchantId, id: pending.id, lease };
      try {
        const envelope = merchantRFQEnvelopeSchema.parse(pending.envelope);
        if (envelope.rfq.merchantId !== pending.merchantId || envelope.rfq.id !== pending.rfqId) throw new Error();
        if (Date.parse(envelope.expiresAt) <= Date.now() || (envelope.rfq.requiredBy && Date.parse(envelope.rfq.requiredBy) <= Date.now())) {
          await db.collection("merchant_telegram_notifications").updateOne(scope, { $set: { status: "expired" } });
          continue;
        }
        const candidate = await db.collection("merchant_telegram_bindings").findOne({ merchantId: pending.merchantId, mode: config.merchantAuthMode, active: true });
        const binding = candidate ? await store.getBinding(candidate.chatId, candidate.userId, config.merchantAuthMode) : null;
        if (!binding || binding.merchantId !== pending.merchantId) {
          await db.collection("merchant_telegram_notifications").updateOne(scope, { $set: { status: "pending", nextAttemptAt: new Date(Date.now() + 60000), reason: "binding_required" } });
          continue;
        }
        await store.getRFQContext(binding, pending.rfqId);
        const sent = await reply(binding.chatId, formatRFQNotification(envelope), { inline_keyboard: [[{ text: "Хариу өгөх", callback_data: `a:${pending.id}` }]] });
        const session = client.startSession();
        try {
          await session.withTransaction(async () => {
            const result = await db.collection("merchant_telegram_notifications").updateOne(scope, { $set: {
              status: "sent", messageId: sent.message_id, bindingId: binding.id, chatId: binding.chatId, sentAt: new Date().toISOString(),
            } }, { session });
            if (result.matchedCount !== 1) throw new Error();
            const audit = auditEventSchema.parse({ contractVersion: "1", id: `sent-${pending.id}`, merchantId: binding.merchantId,
              createdAt: new Date().toISOString(), actorId: "telegram-worker", actorKind: "system", action: "telegram_notified",
              entityId: pending.rfqId, correlationId: envelope.correlationId, outcome: "success" });
            await db.collection("merchant_audit_events").updateOne({ merchantId: binding.merchantId, id: audit.id }, { $setOnInsert: audit }, { upsert: true, session });
          });
        } finally { await session.endSession(); }
      } catch (error) {
        if (error instanceof TelegramAPIError && error.code === "rejected") {
          await db.collection("merchant_telegram_notifications").updateOne(scope, { $set: { status: "failed", reason: "delivery_rejected" } });
          continue;
        }
        await db.collection("merchant_telegram_notifications").updateOne(scope, { $set: { status: "pending",
          nextAttemptAt: new Date(Date.now() + Math.max(Math.min(3600000, 2000 * 2 ** Math.min(pending.attempts ?? 1, 10)),
            error instanceof TelegramAPIError ? error.retryAfter * 1000 : 0)), reason: "retry" } });
      }
    }
  }
  return { processUpdate, flushNotifications };
}

function requireLiveRFQ(envelope: MerchantRFQEnvelope) {
  if (Date.parse(envelope.expiresAt) <= Date.now() || (envelope.rfq.requiredBy && Date.parse(envelope.rfq.requiredBy) <= Date.now()))
    throw new TelegramStoreError("Хүсэлтийн хүчинтэй хугацаа дууссан байна.", "rfq_expired");
}

let runtime: ReturnType<typeof createTelegramRuntime> | undefined;
export async function getTelegramRuntime() {
  if (!runtime) {
    const config = readTelegramConfig();
    runtime = createTelegramRuntime({ client: await getMerchantClient(), db: await getMerchantDb(), config,
      telegram: new TelegramBotAPI(config.token), ai: createAIProvider(readMerchantEnv()) });
  }
  return runtime;
}
