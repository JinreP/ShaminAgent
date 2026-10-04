import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ClientSession, Db, Document, MongoClient } from "mongodb";
import { z } from "zod";
import { auditEventSchema, idSchema, quoteSchema, type Quote } from "../../shared/merchant-contracts";
import { DEMO_MERCHANTS } from "../demo-merchants";
import { settingsSchema } from "../private-contracts";
import { merchantRFQEnvelopeSchema, merchantRFQResponseSchema, type MerchantRFQEnvelope } from "../a2a/contracts";
import { RFQ_PROCESSING_COLLECTION, type MerchantRFQData } from "../a2a/store";
import { loadScopedRFQContext, ScopedRFQDataError } from "../a2a/data";
import { quoteDraftSchema, quoteUpdatesResponseSchema, telegramIdentitySchema, type DraftRecord, type QuoteDraft, type QuoteUpdatesResponse, type TelegramBinding } from "./contracts";

export const telegramCollections = {
  invites: "merchant_telegram_invites", bindings: "merchant_telegram_bindings", updates: "merchant_telegram_updates",
  drafts: "merchant_telegram_drafts", conversations: "merchant_telegram_conversations", publications: "merchant_quote_publications",
} as const;
type BindingMode = TelegramBinding["mode"];
type HumanQuoteData = MerchantRFQData & { settings?: z.infer<typeof settingsSchema> | null };
const bindingSchema = z.strictObject({ id: idSchema, merchantId: idSchema, chatId: telegramIdentitySchema,
  userId: telegramIdentitySchema, mode: z.enum(["demo", "production"]), active: z.boolean() });
const draftRecordSchema = z.strictObject({ id: idSchema, merchantId: idSchema, rfqId: idSchema, correlationId: idSchema,
  bindingId: idSchema, chatId: telegramIdentitySchema, userId: telegramIdentitySchema, draft: quoteDraftSchema,
  status: z.enum(["review", "confirmed", "rejected", "superseded"]), createdAt: z.iso.datetime({ offset: true }),
  quoteId: idSchema.optional(), quoteRevision: z.number().int().positive().optional() });
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` :
  value !== null && typeof value === "object" ? `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}` : JSON.stringify(value);
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const knownMerchant = (id: string) => DEMO_MERCHANTS.some(merchant => merchant.id === id);
const duplicateKey = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === 11000);
const domain = (document: Document): Document => {
  const { _id, _version, ...record } = document; void _id; void _version; return record;
};
function binding(document: Document): TelegramBinding {
  const { id, merchantId, chatId, userId, mode, active } = document;
  return bindingSchema.parse({ id, merchantId, chatId, userId, mode, active });
}
function draftRecord(document: Document): DraftRecord {
  const { id, merchantId, rfqId, correlationId, bindingId, chatId, userId, draft, status, createdAt, quoteId, quoteRevision } = document;
  return draftRecordSchema.parse({ id, merchantId, rfqId, correlationId, bindingId, chatId, userId, draft, status, createdAt,
    ...(quoteId ? { quoteId } : {}), ...(quoteRevision ? { quoteRevision } : {}) });
}
export class TelegramStoreError extends Error {
  constructor(message = "Энэ хүсэлтийг боловсруулах эрхгүй байна.", readonly code = "access_denied") {
    super(message); this.name = "TelegramStoreError";
  }
}
function checkedBinding(input: TelegramBinding): TelegramBinding {
  const result = bindingSchema.safeParse(input);
  if (!result.success || !knownMerchant(result.data.merchantId) || !result.data.active || result.data.chatId !== result.data.userId)
    throw new TelegramStoreError();
  return result.data;
}
function validMode(mode: BindingMode) {
  if (mode !== "demo" && mode !== "production") throw new TelegramStoreError();
}
function validDeadline(envelope: MerchantRFQEnvelope, now = new Date()) {
  if (Date.parse(envelope.expiresAt) <= now.getTime() || (envelope.rfq.requiredBy && Date.parse(envelope.rfq.requiredBy) <= now.getTime()))
    throw new TelegramStoreError("Хүсэлтийн хүчинтэй хугацаа дууссан тул үнийн санал баталгаажуулах боломжгүй байна.", "rfq_expired");
}

/** All private operations recheck a persisted binding. A message-supplied merchant ID never grants access. */
export class TelegramMerchantStore {
  constructor(private readonly client: MongoClient, private readonly db: Db) {}

  private async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try {
      const result = await session.withTransaction(() => work(session), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      if (result === undefined) throw new TelegramStoreError("Өөрчлөлтийг хадгалах боломжгүй байна.", "persistence_error");
      return result;
    } finally { await session.endSession(); }
  }
  private async audit(session: ClientSession, merchantId: string, actorId: string, action: z.infer<typeof auditEventSchema>["action"],
    entityId: string, correlationId: string, actorKind: "merchant" | "system" = "merchant") {
    await this.db.collection("merchant_audit_events").insertOne(auditEventSchema.parse({ contractVersion: "1", id: randomUUID(),
      merchantId, createdAt: new Date().toISOString(), actorId, actorKind, action, entityId, correlationId, outcome: "success" }), { session });
  }
  private async lockBinding(input: TelegramBinding, session: ClientSession): Promise<TelegramBinding> {
    const verified = checkedBinding(input);
    // A write participates in MongoDB conflict detection: revocation cannot race a successful publication.
    const record = await this.db.collection(telegramCollections.bindings).findOneAndUpdate(verified,
      { $inc: { operationVersion: 1 } }, { session, returnDocument: "after" });
    if (!record) throw new TelegramStoreError("Худалдаачны холбоос хүчингүй болсон байна. Администраторт хандана уу.", "binding_revoked");
    return binding(record);
  }
  private async context(merchantId: string, rfqId: string, session: ClientSession): Promise<{ envelope: MerchantRFQEnvelope; data: HumanQuoteData }> {
    try { return await loadScopedRFQContext(this.db, merchantId, rfqId, session); }
    catch (error) {
      if (error instanceof ScopedRFQDataError) throw new TelegramStoreError(error.message, "rfq_not_found");
      throw error;
    }
  }

  async issueInvite(merchantId: string, userId: string, mode: BindingMode, issuedBy: string, ttlMs = 15 * 60000): Promise<{ token: string; id: string }> {
    if (!knownMerchant(merchantId) || !telegramIdentitySchema.safeParse(userId).success || !idSchema.safeParse(issuedBy).success)
      throw new TelegramStoreError();
    validMode(mode);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 24 * 3600000) throw new TelegramStoreError("Бүртгэлийн холбоосын хугацаа буруу байна.");
    const token = randomBytes(32).toString("base64url"), id = `ti-${randomUUID()}`;
    await this.transaction(async session => {
      const profile = await this.db.collection("merchant_profiles").findOne({ merchantId, id: merchantId, active: true }, { session });
      if (!profile || (mode === "demo" && profile.mode !== "simulated")) throw new TelegramStoreError("Идэвхтэй худалдаачин бүртгэгдээгүй байна.");
      await this.db.collection(telegramCollections.invites).insertOne({ contractVersion: "1", id, merchantId, userId, mode,
        tokenHash: hash(token), issuedBy, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ttlMs), consumed: false }, { session });
      await this.audit(session, merchantId, issuedBy, "telegram_binding_issued", id, id, "system");
      return true;
    });
    return { token, id };
  }
  async issueDashboardInvite(merchantId: string, issuedBy: string, ttlMs = 5 * 60000): Promise<{ token: string; id: string }> {
    if (!knownMerchant(merchantId) || !idSchema.safeParse(issuedBy).success) throw new TelegramStoreError();
    const mode: BindingMode = "demo";
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 15 * 60000)
      throw new TelegramStoreError("Бүртгэлийн холбоосын хугацаа буруу байна.");
    const token = randomBytes(32).toString("base64url"), id = `ti-${randomUUID()}`;
    try {
      await this.transaction(async session => {
        const profile = await this.db.collection("merchant_profiles").findOne({ merchantId, id: merchantId, active: true, mode: "simulated" }, { session });
        if (!profile) throw new TelegramStoreError("Идэвхтэй туршилтын худалдаачин бүртгэгдээгүй байна.");
        if (await this.db.collection(telegramCollections.bindings).findOne({ merchantId, mode, active: true }, { session }))
          throw new TelegramStoreError("Телеграм бүртгэл аль хэдийн холбогдсон байна.", "binding_conflict");
        await this.db.collection(telegramCollections.invites).updateMany({ merchantId, mode, dashboardInvite: true, consumed: false },
          { $set: { consumed: true, cancelledAt: new Date().toISOString() } }, { session });
        await this.db.collection(telegramCollections.invites).insertOne({ contractVersion: "1", id, merchantId, userId: null, mode, dashboardInvite: true,
          tokenHash: hash(token), issuedBy, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ttlMs), consumed: false }, { session });
        await this.audit(session, merchantId, issuedBy, "telegram_binding_issued", id, id, "merchant");
        return true;
      });
    } catch (error) {
      if (duplicateKey(error)) throw new TelegramStoreError("Өмнөх бүртгэлийн холбоос боловсруулагдаж байна. Төлөвийг шалгана уу.", "binding_conflict");
      throw error;
    }
    return { token, id };
  }
  async bind(token: string, chatId: string, userId: string, mode: BindingMode): Promise<TelegramBinding> {
    validMode(mode);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !telegramIdentitySchema.safeParse(chatId).success ||
      !telegramIdentitySchema.safeParse(userId).success || chatId !== userId) throw new TelegramStoreError("Бүртгэлийн холбоос эсвэл хэрэглэгчийн эрх буруу байна.");
    try {
      return await this.transaction(async session => {
        const invite = await this.db.collection(telegramCollections.invites).findOneAndUpdate({ tokenHash: hash(token), mode,
          $or: [{ userId }, { userId: null }],
          consumed: false, expiresAt: { $gt: new Date() } }, { $set: { consumed: true, consumedAt: new Date().toISOString(), claimedUserId: userId } }, { session, returnDocument: "after" });
        if (!invite || !knownMerchant(invite.merchantId)) throw new TelegramStoreError("Бүртгэлийн холбоос ашиглагдсан, хугацаа дууссан эсвэл таны эрхэд тохирохгүй байна.", "invalid_invite");
        const merchantId = String(invite.merchantId);
        if (!await this.db.collection("merchant_profiles").findOne({ merchantId, id: merchantId, active: true }, { session })) throw new TelegramStoreError();
        const record: TelegramBinding = { id: `tb-${randomUUID()}`, merchantId, chatId, userId, mode, active: true };
        await this.db.collection(telegramCollections.bindings).insertOne({ ...record, createdAt: new Date().toISOString(), operationVersion: 0 }, { session });
        await this.audit(session, merchantId, `telegram-${userId}`, "telegram_bound", record.id, invite.id);
        return record;
      });
    } catch (error) {
      if (duplicateKey(error)) throw new TelegramStoreError("Энэ хэрэглэгч эсвэл худалдаачин аль хэдийн холбогдсон байна. Администраторт хандана уу.", "binding_conflict");
      throw error;
    }
  }
  async getMerchantBinding(merchantId: string, mode: BindingMode = "demo"): Promise<TelegramBinding | null> {
    if (!knownMerchant(merchantId)) throw new TelegramStoreError();
    validMode(mode);
    const record = await this.db.collection(telegramCollections.bindings).findOne({ merchantId, mode, active: true });
    return record ? binding(record) : null;
  }
  async revokeMerchantBinding(merchantId: string, issuedBy: string, mode: BindingMode = "demo"): Promise<void> {
    if (!knownMerchant(merchantId) || !idSchema.safeParse(issuedBy).success) throw new TelegramStoreError();
    validMode(mode);
    await this.transaction(async session => {
      const previous = await this.db.collection(telegramCollections.bindings).findOneAndUpdate({ merchantId, mode, active: true },
        { $set: { active: false, revokedAt: new Date().toISOString(), revokedBy: issuedBy }, $inc: { operationVersion: 1 } },
        { session, returnDocument: "before" });
      await this.db.collection(telegramCollections.invites).updateMany({ merchantId, mode, dashboardInvite: true, consumed: false },
        { $set: { consumed: true, cancelledAt: new Date().toISOString() } }, { session });
      if (previous) await this.audit(session, merchantId, issuedBy, "telegram_revoked", String(previous.id), String(previous.id), "merchant");
      return true;
    });
  }
  async revokeBinding(id: string, issuedBy: string): Promise<void> {
    idSchema.parse(id); idSchema.parse(issuedBy);
    await this.transaction(async session => {
      const previous = await this.db.collection(telegramCollections.bindings).findOneAndUpdate({ id, active: true },
        { $set: { active: false, revokedAt: new Date().toISOString(), revokedBy: issuedBy }, $inc: { operationVersion: 1 } }, { session, returnDocument: "before" });
      if (previous) await this.audit(session, previous.merchantId, issuedBy, "telegram_revoked", id, id, "system");
      return true;
    });
  }
  async getBinding(chatId: string, userId: string, mode: BindingMode): Promise<TelegramBinding | null> {
    validMode(mode);
    if (!telegramIdentitySchema.safeParse(chatId).success || !telegramIdentitySchema.safeParse(userId).success || chatId !== userId) return null;
    const record = await this.db.collection(telegramCollections.bindings).findOne({ chatId, userId, mode, active: true });
    return record && knownMerchant(record.merchantId) ? binding(record) : null;
  }

  async claimUpdate(botKey: string, updateId: number): Promise<string | null> {
    idSchema.parse(botKey); z.number().int().nonnegative().safe().parse(updateId);
    const identity = { botKey, updateId }, now = new Date();
    try {
      await this.db.collection(telegramCollections.updates).updateOne(identity, { $setOnInsert: { ...identity,
        status: "pending", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 86400000) } }, { upsert: true });
    } catch (error) { if (!duplicateKey(error)) throw error; }
    const leaseToken = randomUUID();
    const claimed = await this.db.collection(telegramCollections.updates).findOneAndUpdate({ ...identity,
      $or: [{ status: "pending" }, { status: "failed" }, { status: "processing", leaseUntil: { $lte: now } }] },
    { $set: { status: "processing", leaseToken, leaseUntil: new Date(now.getTime() + 120000), startedAt: now.toISOString() }, $inc: { attempts: 1 } }, { returnDocument: "after" });
    return claimed ? leaseToken : null;
  }
  async completeUpdate(botKey: string, updateId: number, leaseToken: string): Promise<void> {
    await this.finishUpdate(botKey, updateId, leaseToken, "done");
  }
  async failUpdate(botKey: string, updateId: number, leaseToken: string): Promise<void> {
    await this.finishUpdate(botKey, updateId, leaseToken, "failed");
  }
  async renewUpdate(botKey: string, updateId: number, leaseToken: string): Promise<boolean> {
    idSchema.parse(botKey); z.number().int().nonnegative().safe().parse(updateId); idSchema.parse(leaseToken);
    const now = new Date();
    const result = await this.db.collection(telegramCollections.updates).updateOne({ botKey, updateId, status: "processing", leaseToken,
      leaseUntil: { $gt: now } }, { $set: { leaseUntil: new Date(now.getTime() + 120000) } });
    return result.matchedCount === 1;
  }
  private async finishUpdate(botKey: string, updateId: number, leaseToken: string, status: "done" | "failed") {
    idSchema.parse(botKey); z.number().int().nonnegative().safe().parse(updateId); idSchema.parse(leaseToken);
    const result = await this.db.collection(telegramCollections.updates).updateOne({ botKey, updateId, status: "processing", leaseToken,
      ...(status === "done" ? { leaseUntil: { $gt: new Date() } } : {}) },
      { $set: { status, completedAt: new Date().toISOString() }, $unset: { leaseToken: "", leaseUntil: "" } });
    if (status === "done" && result.matchedCount !== 1)
      throw new TelegramStoreError("Хариуг боловсруулах эрхийн хугацаа дууссан байна. Дахин оролдоно уу.", "update_lease_lost");
  }

  async getRFQContext(input: TelegramBinding, rfqId: string): Promise<{ envelope: MerchantRFQEnvelope; data: HumanQuoteData }> {
    return this.transaction(async session => { const verified = await this.lockBinding(input, session); return this.context(verified.merchantId, rfqId, session); });
  }
  async getDraft(input: TelegramBinding, draftId: string): Promise<DraftRecord> {
    idSchema.parse(draftId);
    return this.transaction(async session => {
      const verified = await this.lockBinding(input, session);
      const record = await this.db.collection(telegramCollections.drafts).findOne({ id: draftId, merchantId: verified.merchantId,
        bindingId: verified.id, chatId: verified.chatId, userId: verified.userId }, { session });
      if (!record) throw new TelegramStoreError("Энэ худалдаачны үнийн саналын ноорог олдсонгүй.", "draft_not_found");
      return draftRecord(record);
    });
  }
  async recordConversation(input: TelegramBinding, rfqId: string, rawText: string, updateId: number): Promise<void> {
    const verified = checkedBinding(input);
    z.string().min(1).max(6000).parse(rawText); z.number().int().nonnegative().safe().parse(updateId); idSchema.parse(rfqId);
    await this.transaction(async session => {
      await this.lockBinding(verified, session);
      const { envelope } = await this.context(verified.merchantId, rfqId, session); validDeadline(envelope);
      await this.conversation(session, verified, envelope, rawText, updateId);
      return true;
    });
  }
  private async conversation(session: ClientSession, verified: TelegramBinding, envelope: MerchantRFQEnvelope,
    rawText: string, updateId: number, attachment?: { draftId: string; status: "draft" | "superseded" }): Promise<void> {
    const identity = { merchantId: verified.merchantId, id: `tc-${hash([verified.id, updateId]).slice(0, 40)}` };
    const previous = await this.db.collection(telegramCollections.conversations).findOne(identity, { session });
    if (previous && (previous.rfqId !== envelope.rfq.id || previous.bindingId !== verified.id || previous.text !== rawText))
      throw new TelegramStoreError("Энэ хариу өмнө нь өөр мэдээллээр бүртгэгдсэн байна.", "conversation_conflict");
    const now = new Date();
    await this.db.collection(telegramCollections.conversations).updateOne(identity, {
      $setOnInsert: { contractVersion: "1", ...identity, rfqId: envelope.rfq.id, correlationId: envelope.correlationId,
        bindingId: verified.id, chatId: verified.chatId, userId: verified.userId, updateId, direction: "merchant", text: rawText,
        createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 86400000) }, ...(attachment ? { $set: attachment } : {}),
    }, { session, upsert: true });
  }
  async saveDraft(input: TelegramBinding, rfqId: string, inputDraft: QuoteDraft, rawText: string, updateId: number): Promise<DraftRecord> {
    const verified = checkedBinding(input), draft = quoteDraftSchema.parse(inputDraft);
    z.string().min(1).max(6000).parse(rawText); z.number().int().nonnegative().safe().parse(updateId); idSchema.parse(rfqId);
    const id = `td-${hash([verified.id, updateId]).slice(0, 40)}`, inputHash = hash({ rfqId, draft, rawText });
    return this.transaction(async session => {
      await this.lockBinding(verified, session);
      const previous = await this.db.collection(telegramCollections.drafts).findOne({ id, merchantId: verified.merchantId, bindingId: verified.id }, { session });
      if (previous) {
        if (previous.inputHash !== inputHash) throw new TelegramStoreError("Энэ хариу өмнө нь өөр мэдээллээр бүртгэгдсэн байна.", "draft_conflict");
        return draftRecord(previous);
      }
      const { envelope } = await this.context(verified.merchantId, rfqId, session); validDeadline(envelope);
      const newer = await this.db.collection(telegramCollections.drafts).find({ merchantId: verified.merchantId, rfqId,
        bindingId: verified.id, telegramUpdateId: { $gt: updateId } }, { session }).sort({ telegramUpdateId: -1 }).limit(1).toArray();
      if (newer[0]) {
        await this.conversation(session, verified, envelope, rawText, updateId, { draftId: newer[0].id, status: "superseded" });
        return draftRecord(newer[0]);
      }
      const record: DraftRecord = { id, merchantId: verified.merchantId, rfqId, correlationId: envelope.correlationId,
        bindingId: verified.id, chatId: verified.chatId, userId: verified.userId, draft, status: "review", createdAt: new Date().toISOString() };
      await this.db.collection(telegramCollections.drafts).updateMany({ merchantId: verified.merchantId, rfqId, bindingId: verified.id, status: "review" },
        { $set: { status: "superseded", supersededAt: record.createdAt } }, { session });
      await this.db.collection(telegramCollections.drafts).insertOne({ ...record, inputHash, telegramUpdateId: updateId }, { session });
      await this.conversation(session, verified, envelope, rawText, updateId, { draftId: id, status: "draft" });
      await this.audit(session, verified.merchantId, `telegram-${verified.userId}`, "telegram_draft_created", id, envelope.correlationId);
      return record;
    });
  }
  async rejectDraft(input: TelegramBinding, draftId: string): Promise<void> {
    idSchema.parse(draftId);
    await this.transaction(async session => {
      const verified = await this.lockBinding(input, session);
      const previous = await this.db.collection(telegramCollections.drafts).findOne({ id: draftId, merchantId: verified.merchantId, bindingId: verified.id }, { session });
      if (!previous) throw new TelegramStoreError("Үнийн саналын ноорог олдсонгүй.", "draft_not_found");
      if (previous.status === "rejected") return true;
      if (previous.status !== "review") throw new TelegramStoreError("Энэ ноорог өмнө нь шийдвэрлэгдсэн байна.", "draft_closed");
      await this.db.collection(telegramCollections.drafts).updateOne({ id: draftId, merchantId: verified.merchantId, bindingId: verified.id, status: "review" },
        { $set: { status: "rejected", rejectedAt: new Date().toISOString() } }, { session });
      await this.audit(session, verified.merchantId, `telegram-${verified.userId}`, "telegram_draft_rejected", draftId, previous.correlationId);
      return true;
    });
  }
  async confirmDraft(input: TelegramBinding, draftId: string,
    validate: (data: HumanQuoteData, envelope: MerchantRFQEnvelope, draft: QuoteDraft, now: Date, revision: number) => Quote): Promise<Quote> {
    idSchema.parse(draftId);
    return this.transaction(async session => {
      const verified = await this.lockBinding(input, session);
      const document = await this.db.collection(telegramCollections.drafts).findOne({ id: draftId, merchantId: verified.merchantId, bindingId: verified.id }, { session });
      if (!document) throw new TelegramStoreError("Үнийн саналын ноорог олдсонгүй.", "draft_not_found");
      const record = draftRecord(document);
      if (record.status === "confirmed") {
        const published = await this.db.collection("merchant_quotes").findOne({ merchantId: verified.merchantId, id: record.quoteId, revision: record.quoteRevision }, { session });
        if (!published) throw new TelegramStoreError("Баталгаажсан үнийн санал олдсонгүй.", "publication_missing");
        return quoteSchema.parse(domain(published));
      }
      if (record.status !== "review") throw new TelegramStoreError("Энэ ноорог өмнө нь шийдвэрлэгдсэн байна.", "draft_closed");
      const { envelope, data } = await this.context(verified.merchantId, record.rfqId, session), now = new Date(); validDeadline(envelope, now);
      const latest = await this.db.collection("merchant_quotes").find({ merchantId: verified.merchantId, rfqId: record.rfqId }, { session }).sort({ revision: -1 }).limit(1).toArray();
      const revision = (latest[0]?.revision ?? 0) + 1;
      const quote = quoteSchema.parse(validate(data, envelope, record.draft, now, revision));
      if (quote.merchantId !== verified.merchantId || quote.buyerId !== envelope.rfq.buyerId || quote.rfqId !== record.rfqId ||
        quote.kind !== envelope.rfq.kind || quote.revision !== revision || quote.reservation !== false || quote.status !== "offered" ||
        Date.parse(quote.expiresAt) > Date.parse(envelope.expiresAt) || !data.profile?.active || quote.mode !== data.profile.mode)
        throw new TelegramStoreError("Баталгаажуулах үнийн санал хүсэлтийн мэдээлэлтэй тохирохгүй байна.", "invalid_quote");
      const resources = quote.kind === "parts" ? data.inventory : data.services;
      for (const line of quote.lines) {
        const resource = resources.find(candidate => candidate.id === line.resourceId && candidate.merchantId === verified.merchantId && candidate.active);
        if (!resource || line.unitPrice.currency !== resource.price.currency || line.unitPrice.amountMinor < resource.minimumPrice.amountMinor)
          throw new TelegramStoreError("Үнийн санал худалдаачны нөхцөлтэй тохирохгүй байна.", "invalid_quote");
        if ("stock" in resource && quote.lines.filter(candidate => candidate.resourceId === resource.id).reduce((sum, candidate) => sum + candidate.quantity, 0) > resource.stock)
          throw new TelegramStoreError("Сэлбэгийн нөөц хүрэлцэхгүй байна.", "insufficient_stock");
      }
      const selectedSlot = quote.kind === "repair" ? data.slots.find(slot => slot.id === record.draft.slotId && slot.merchantId === verified.merchantId) : undefined;
      if (quote.kind === "repair" && !selectedSlot) throw new TelegramStoreError("Сонгосон засварын цаг олдсонгүй.", "invalid_quote");
      const serviceWindow = selectedSlot ? { startsAt: selectedSlot.startsAt, endsAt: selectedSlot.endsAt } : undefined;
      // Revision uniqueness serializes simultaneous confirmations. Quotes remain non-reserving.
      await this.db.collection("merchant_quotes").updateMany({ merchantId: verified.merchantId, rfqId: record.rfqId, status: "offered" }, { $set: { status: "superseded" } }, { session });
      await this.db.collection("merchant_quotes").insertOne(structuredClone(quote), { session });
      await this.db.collection(telegramCollections.publications).insertOne({ contractVersion: "1", id: quote.id, merchantId: verified.merchantId,
        rfqId: record.rfqId, buyerId: quote.buyerId, quoteId: quote.id, quoteRevision: quote.revision, draftId, source: "human_confirmed",
        status: "published", correlationId: record.correlationId, createdAt: now.toISOString(), ...(serviceWindow ? { serviceWindow } : {}) }, { session });
      await this.db.collection(telegramCollections.drafts).updateOne({ id: draftId, merchantId: verified.merchantId, bindingId: verified.id, status: "review" },
        { $set: { status: "confirmed", quoteId: quote.id, quoteRevision: quote.revision, confirmedAt: now.toISOString() } }, { session });
      await this.db.collection("merchant_rfqs").updateOne({ merchantId: verified.merchantId, id: record.rfqId }, { $set: { status: "quoted" } }, { session });
      await this.audit(session, verified.merchantId, `telegram-${verified.userId}`, "telegram_draft_confirmed", draftId, record.correlationId);
      await this.audit(session, verified.merchantId, `telegram-${verified.userId}`, "quote_created", quote.id, record.correlationId);
      await this.audit(session, verified.merchantId, `telegram-${verified.userId}`, "quote_published", quote.id, record.correlationId);
      return quote;
    });
  }
  async getQuoteUpdates(merchantId: string, buyerId: string, rfqId: string, afterRevision: number): Promise<QuoteUpdatesResponse> {
    if (!knownMerchant(merchantId)) throw new TelegramStoreError();
    idSchema.parse(buyerId); idSchema.parse(rfqId); z.number().int().nonnegative().safe().parse(afterRevision);
    return this.transaction(async session => {
      const processing = await this.db.collection(RFQ_PROCESSING_COLLECTION).findOne({ merchantId, id: rfqId, buyerId }, { session });
      if (!processing) throw new TelegramStoreError("Таны үнийн саналын хүсэлт олдсонгүй.", "rfq_not_found");
      const envelope = merchantRFQEnvelopeSchema.parse(processing.envelope);
      if (envelope.rfq.merchantId !== merchantId || envelope.rfq.buyerId !== buyerId) throw new TelegramStoreError();
      const documents = await this.db.collection("merchant_quotes").find({ merchantId, rfqId, buyerId }, { session }).sort({ revision: 1 }).toArray();
      const publications = await this.db.collection(telegramCollections.publications).find({ merchantId, rfqId, buyerId, status: "published" }, { session }).toArray();
      const quotes = documents.map(document => quoteSchema.parse(domain(document)));
      const automatic = merchantRFQResponseSchema.safeParse(processing.response);
      return quoteUpdatesResponseSchema.parse({ contractVersion: "1", action: "quote_updates", merchantId, rfqId, correlationId: envelope.correlationId,
        latestRevision: quotes.reduce((latest, quote) => Math.max(latest, quote.revision), 0), quotes: quotes.filter(quote => quote.revision > afterRevision)
          .map(quote => {
            const publication = publications.find(candidate => candidate.quoteId === quote.id && candidate.quoteRevision === quote.revision);
            const serviceWindow = publication?.serviceWindow ?? (automatic.success && automatic.data.quote?.id === quote.id &&
              automatic.data.quote?.revision === quote.revision ? automatic.data.serviceWindow : undefined);
            return { quote, source: publication?.source === "negotiated" ? "negotiated" :
              publication?.source === "human_confirmed" ? "human_confirmed" : "automatic", ...(serviceWindow ? { serviceWindow } : {}) };
          }) });
    });
  }
}
