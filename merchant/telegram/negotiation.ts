import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Db, MongoClient } from "mongodb";
import { auditEventSchema, moneySchema, quoteSchema, type Money, type Quote } from "../../shared/merchant-contracts";
import type { TelegramAPI, InlineKeyboard } from "./api";
import { TelegramAPIError } from "./api";
import type { TelegramBinding, TelegramUpdate } from "./contracts";
import type { TelegramConfig } from "./config";
import { TelegramStoreError } from "./store";
import { merchantName } from "../i18n";

type ResultView = { outcome: "pending" | "accepted" | "countered" | "rejected"; message?: string; quote?: Quote };
export type NegotiationHumanView = {
  telegramHandle: string; rfqId: string; negotiationId: string; expiresAt: string;
  originalQuote: Quote; requestedTotal: Money; proposedTotal: Money; response: ResultView;
  counterDraft?: { total: Money; updateId: number; bindingId: string };
};
/** The persistent store is the sole authority for scope, private rules, deadlines and quote publication. */
export interface NegotiationTelegramStore {
  getHumanContext(binding: TelegramBinding, handle: string): Promise<NegotiationHumanView>;
  prepareHumanCounter(binding: TelegramBinding, handle: string, total: Money, updateId: number): Promise<{ response: ResultView; updateId: number }>;
  decideHuman(binding: TelegramBinding, handle: string, decision: "accept" | "counter" | "reject", counterVersion?: number): Promise<ResultView>;
  expirePending(limit?: number): Promise<unknown>;
}
export type NegotiationLink = { kind: "negotiation"; negotiationHandle: string };
type Dependencies = {
  store: NegotiationTelegramStore; db: Db; client: MongoClient; api: TelegramAPI; config: TelegramConfig;
  getBinding(chatId: string, userId: string, mode: "demo" | "production"): Promise<TelegramBinding | null>;
  prompt(binding: TelegramBinding, rfqId: string, text: string, buttons?: InlineKeyboard, link?: NegotiationLink): Promise<void>;
  acknowledge(id: string, text: string): Promise<void>;
};
const handlePattern = /^ng-[a-f0-9]{40}$/;
const price = (total: Money) => `${(total.amountMinor / 100).toLocaleString("mn-MN")} төгрөг`;
const decisionButtons = (handle: string): InlineKeyboard => ({ inline_keyboard: [[
  { text: "Зөвшөөрөх", callback_data: `na:${handle}` },
  { text: "Өөр үнэ санал болгох", callback_data: `nc:${handle}` },
  { text: "Татгалзах", callback_data: `nr:${handle}` },
]] });
const counterButtons = (handle: string, version: number): InlineKeyboard => ({ inline_keyboard: [[
  { text: "Баталгаажуулах", callback_data: `nx:${handle}:${version}` },
  { text: "Засах", callback_data: `nc:${handle}` },
  { text: "Татгалзах", callback_data: `nr:${handle}` },
]] });

/** A negotiation total is an integer MNT amount. Language interpretation and AI never decide money. */
export function parseNegotiationCounter(text: string): Money | null {
  const match = /^\s*([0-9]{1,16})\s*(?:төгрөг|₮)?\s*$/u.exec(text);
  if (!match) return null;
  const minor = BigInt(match[1]) * BigInt(100);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return moneySchema.parse({ amountMinor: Number(minor), currency: "MNT" });
}
function resultText(result: ResultView): string {
  const labels = { pending: "Үнийн тохиролцооны хүсэлт шийдвэр хүлээж байна.", accepted: "Үнийн тохиролцоог зөвшөөрч хадгаллаа.",
    countered: "Худалдаачны өөр үнийн саналыг баталгаажуулж хадгаллаа.", rejected: "Үнийн тохиролцооны хүсэлтийг татгалзсан гэж хадгаллаа." };
  return `${result.message ?? labels[result.outcome]}${result.quote ? `\nБаталгаажсан саналын нийт: ${price(result.quote.total)}\nСаналын хувилбар: ${result.quote.revision}` : ""}\nХудалдан авагч агентын шинэчлэлтээр үр дүнг авна. Бараа, засварын цаг захиалаагүй.`;
}
function notificationText(input: { merchantId: string; rfqId: string; negotiationId: string; expiresAt: string; originalQuote: Quote; proposedTotal: Money }) {
  return `ҮНИЙН ТОХИРОЛЦООНЫ ХҮСЭЛТ\n\n${merchantName(input.merchantId)}\nХүсэлтийн дугаар: ${input.rfqId}\nТохиролцооны дугаар: ${input.negotiationId}\nОдоогийн санал: ${input.originalQuote.id}\nСаналын хувилбар: ${input.originalQuote.revision}\nОдоогийн нийт үнэ: ${price(input.originalQuote.total)}\nХудалдан авагчийн санал болгосон нийт үнэ: ${price(input.proposedTotal)}\nХариу өгөх хугацаа: ${input.expiresAt}\n\nЗөвшөөрөх, өөр нийт үнэ санал болгох эсвэл татгалзах товчийг сонгоно уу. Хувийн үнийн дүрмийг сервер шалгана. Баталгаажсан тохиролцоо бараа, засварын цаг захиалахгүй.`;
}

export function createNegotiationTelegram({ store, db, client, api, config, getBinding, prompt, acknowledge }: Dependencies) {
  async function show(binding: TelegramBinding, context: NegotiationHumanView, text: string, buttons?: InlineKeyboard) {
    await prompt(binding, context.rfqId, text, buttons, { kind: "negotiation", negotiationHandle: context.telegramHandle });
  }
  async function enterCounter(binding: TelegramBinding, context: NegotiationHumanView) {
    if (context.response.outcome !== "pending") { await show(binding, context, resultText(context.response)); return; }
    await db.collection("merchant_telegram_sessions").updateOne({ merchantId: binding.merchantId, bindingId: binding.id },
      { $set: { kind: "negotiation", negotiationHandle: context.telegramHandle, rfqId: context.rfqId,
        chatId: binding.chatId, userId: binding.userId, updatedAt: new Date() } }, { upsert: true });
    await show(binding, context, `ТОХИРОЛЦООНЫ ӨӨР ҮНИЙН САНАЛ\nХүсэлт: ${context.rfqId}\nОдоогийн нийт үнэ: ${price(context.originalQuote.total)}\nХудалдан авагчийн санал: ${price(context.proposedTotal)}\nХариу өгөх хугацаа: ${context.expiresAt}\n\nӨөрийн санал болгох нийт үнийг бүхэл төгрөгөөр бичнэ үү. Жишээ: 640000 төгрөг. Нэгж үнэ бичихгүй. Илгээсэн үнэ ноорог бөгөөд тусад нь баталгаажуулна.`,
      { inline_keyboard: [[{ text: "Татгалзах", callback_data: `nr:${context.telegramHandle}` }]] });
  }
  async function handle(binding: TelegramBinding, update: TelegramUpdate): Promise<boolean> {
    const callback = update.callback_query;
    if (callback?.data?.startsWith("n")) {
      const action = /^n([acrx]):(ng-[a-f0-9]{40})(?::([0-9]{1,16}))?$/.exec(callback.data);
      if (!action || (action[1] === "x") !== Boolean(action[3])) {
        await acknowledge(callback.id, "Тохиролцооны үйлдэл буруу байна."); return true;
      }
      const [, kind, handle, version] = action;
      const context = await store.getHumanContext(binding, handle);
      await acknowledge(callback.id, "Тохиролцооны хүсэлтийг шалгаж байна.");
      if (kind === "c") { await enterCounter(binding, context); return true; }
      if (context.response.outcome !== "pending") { await show(binding, context, resultText(context.response)); return true; }
      const counterVersion = version === undefined ? undefined : Number(version);
      const counterDraft = context.counterDraft;
      if (kind === "x" && (!Number.isSafeInteger(counterVersion) || !counterDraft || counterDraft.updateId !== counterVersion ||
          counterDraft.bindingId !== binding.id)) throw new TelegramStoreError("Өөр үнийн ноорог шинэчлэгдсэн байна. Сүүлийн нооргийн товчийг ашиглана уу.");
      const response = await store.decideHuman(binding, handle, kind === "a" ? "accept" : kind === "r" ? "reject" : "counter", counterVersion);
      await show(binding, context, resultText(response));
      return true;
    }
    if (!update.message?.text || update.message.text.startsWith("/")) return false;
    let handle: string | undefined;
    if (update.message.reply_to_message) {
      const link = await db.collection("merchant_telegram_message_links").findOne({ merchantId: binding.merchantId, bindingId: binding.id,
        chatId: binding.chatId, messageId: update.message.reply_to_message.message_id, kind: "negotiation" });
      handle = link?.negotiationHandle;
      if (!handle) return false; // An explicit reply to an RFQ must stay in the Phase 4 quoting flow.
    } else {
      const session = await db.collection("merchant_telegram_sessions").findOne({ merchantId: binding.merchantId, bindingId: binding.id,
        chatId: binding.chatId, userId: binding.userId, kind: "negotiation" });
      handle = session?.negotiationHandle;
    }
    if (!handle || !handlePattern.test(handle)) return false;
    const context = await store.getHumanContext(binding, handle);
    if (context.response.outcome !== "pending") { await show(binding, context, resultText(context.response)); return true; }
    const total = parseNegotiationCounter(update.message.text);
    if (!total) {
      await show(binding, context, "Нийт үнийг бүхэл төгрөгөөр бичнэ үү. Жишээ: 640000 төгрөг. Үгийг тайлбарлуулах болон тооцоолуулахад хиймэл оюун ашиглахгүй.");
      return true;
    }
    const prepared = await store.prepareHumanCounter(binding, handle, total, update.update_id);
    if (prepared.response.outcome !== "pending") { await show(binding, context, resultText(prepared.response)); return true; }
    await show(binding, context, `ТОХИРОЛЦООНЫ ӨӨР ҮНИЙН НООРОГ\nХүсэлт: ${context.rfqId}\nОдоогийн нийт үнэ: ${price(context.originalQuote.total)}\nХудалдан авагчийн санал: ${price(context.proposedTotal)}\nТаны өөр нийт үнийн санал: ${price(total)}\nХариу өгөх хугацаа: ${context.expiresAt}\n\nҮнэ зөв эсэхийг шалгаад Баталгаажуулах товчийг дарна уу. Баталгаажуулах хүртэл худалдан авагчид нийтлэхгүй.`,
      counterButtons(handle, prepared.updateId));
    return true;
  }

  async function flush() {
    await store.expirePending(20);
    const candidates = await db.collection("merchant_telegram_bindings").find({ mode: config.merchantAuthMode, active: true }).toArray();
    for (const candidate of candidates) {
      const binding = await getBinding(candidate.chatId, candidate.userId, config.merchantAuthMode);
      if (!binding || binding.merchantId !== candidate.merchantId) continue;
      for (let attempt = 0; attempt < 5; attempt++) {
        const now = new Date(), lease = randomUUID();
        const pending = await db.collection("merchant_negotiation_processing").findOneAndUpdate({ merchantId: binding.merchantId, status: "pending", $or: [
          { notificationStatus: "pending", nextAttemptAt: { $lte: now } },
          { notificationStatus: "sending", notificationLeaseUntil: { $lte: now } },
        ] }, { $set: { notificationStatus: "sending", notificationLease: lease, notificationLeaseUntil: new Date(now.getTime() + 180000) },
          $inc: { notificationAttempts: 1 } }, { returnDocument: "after", sort: { nextAttemptAt: 1 } });
        if (!pending) break;
        const scope = { merchantId: binding.merchantId, id: pending.id, notificationLease: lease };
        try {
          const originalQuote = quoteSchema.parse(pending.originalQuote), proposedTotal = moneySchema.parse(pending.proposedTotal);
          if (originalQuote.merchantId !== binding.merchantId || originalQuote.rfqId !== pending.rfqId || originalQuote.buyerId !== pending.buyerId ||
              !handlePattern.test(pending.telegramHandle) || proposedTotal.currency !== "MNT" || originalQuote.total.currency !== "MNT") throw new Error();
          if (!Number.isFinite(Date.parse(pending.expiresAt)) || Date.parse(pending.expiresAt) <= Date.now()) {
            await db.collection("merchant_negotiation_processing").updateOne(scope, { $set: { notificationStatus: "expired" } });
            continue;
          }
          const sent = await api.sendMessage(binding.chatId, notificationText({ merchantId: binding.merchantId, rfqId: pending.rfqId,
            negotiationId: pending.id, expiresAt: pending.expiresAt, originalQuote, proposedTotal }), decisionButtons(pending.telegramHandle));
          const session = client.startSession();
          try {
            await session.withTransaction(async () => {
              const active = await db.collection("merchant_telegram_bindings").updateOne({ id: binding.id, merchantId: binding.merchantId,
                chatId: binding.chatId, userId: binding.userId, mode: binding.mode, active: true }, { $inc: { operationVersion: 1 } }, { session });
              if (active.matchedCount !== 1) throw new TelegramStoreError("Худалдаачны холбоос хүчингүй болсон байна.");
              const result = await db.collection("merchant_negotiation_processing").updateOne({ ...scope, status: "pending" }, { $set: {
                notificationStatus: "sent", notificationBindingId: binding.id, notificationChatId: binding.chatId,
                notificationMessageId: sent.message_id, notificationSentAt: new Date().toISOString(),
              } }, { session });
              if (result.matchedCount !== 1) throw new Error();
              const audit = auditEventSchema.parse({ contractVersion: "1", merchantId: binding.merchantId,
                id: `tn-${createHash("sha256").update(`${binding.merchantId}:${pending.id}`).digest("hex").slice(0, 48)}`,
                createdAt: new Date().toISOString(), actorId: "telegram-worker", actorKind: "system", action: "negotiation_notified",
                entityId: pending.id, correlationId: pending.correlationId, outcome: "success" });
              await db.collection("merchant_audit_events").updateOne({ merchantId: binding.merchantId, id: audit.id }, { $setOnInsert: audit }, { session, upsert: true });
            });
          } finally { await session.endSession(); }
        } catch (error) {
          await db.collection("merchant_negotiation_processing").updateOne(scope, { $set: {
            notificationStatus: error instanceof TelegramAPIError && error.code === "rejected" ? "failed" : "pending",
            nextAttemptAt: new Date(Date.now() + Math.max(Math.min(3600000, 2000 * 2 ** Math.min(pending.notificationAttempts ?? 1, 10)),
              error instanceof TelegramAPIError ? error.retryAfter * 1000 : 0)), notificationReason: "delivery_failed",
          } });
        }
      }
    }
  }
  return { handle, flush };
}
