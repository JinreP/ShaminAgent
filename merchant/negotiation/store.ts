import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ClientSession, Db, Document, MongoClient } from "mongodb";
import { auditEventSchema, idSchema, quoteSchema, type Money, type Negotiation, type Quote } from "../../shared/merchant-contracts";
import { DEMO_MERCHANTS } from "../demo-merchants";
import { loadScopedRFQContext, ScopedRFQDataError } from "../a2a/data";
import type { MerchantRFQEnvelope } from "../a2a/contracts";
import { RFQ_PROCESSING_COLLECTION } from "../a2a/store";
import type { TelegramBinding } from "../telegram/contracts";
import { telegramIdentitySchema } from "../telegram/contracts";
import { settingsSchema } from "../private-contracts";
import { priceNegotiatedQuote, validateHumanNegotiationPrice, NegotiationRuleError } from "./engine";
import { negotiateQuoteRequestSchema, negotiationResponseSchema,
  type NegotiationCode, type NegotiationResponse, type NegotiationRequest } from "./contracts";

const processingCollection = "merchant_negotiation_processing";
const recordCollection = "merchant_negotiations";
const guardCollection = "merchant_negotiation_guards";
const eventCollection = "merchant_telegram_negotiation_events";
const handlePattern = /^ng-[a-f0-9]{40}$/;

export class NegotiationStoreError extends Error {
  constructor(readonly code: "conflict" | "access_denied" | "stale_counter") {
    super(code === "conflict" ? "Үнэ тохиролцооны хүсэлт давхар эсвэл өөр мэдээлэлтэй байна." :
      code === "stale_counter" ? "Өөр үнийн ноорог шинэчлэгдсэн байна. Сүүлийн нооргийн товчийг ашиглана уу." :
        "Энэ үнэ тохиролцооны хүсэлтэд хандах эрхгүй байна.");
    this.name = "NegotiationStoreError";
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const duplicateKey = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === 11000);
const domain = (document: Document): Document => {
  const { _id, _version, ...record } = document; void _id; void _version; return record;
};
const knownMerchant = (merchantId: string) => DEMO_MERCHANTS.some(merchant => merchant.id === merchantId);
const safeMessages: Record<NegotiationCode, string> = {
  stale_quote: "Үнийн саналын хувилбар хуучирсан байна. Шинэ саналыг авна уу.",
  quote_expired: "Үнийн саналын хүчинтэй хугацаа дууссан байна.",
  rfq_expired: "Үнийн саналын хүсэлтийн хүчинтэй хугацаа дууссан байна.",
  negotiation_disabled: "Худалдаачин үнэ тохиролцох хүсэлт одоогоор хүлээн авахгүй байна.",
  round_limit: "Үнэ тохиролцох оролдлогын зөвшөөрсөн тоонд хүрсэн байна.",
  negotiation_pending: "Үнэ тохиролцох өөр хүсэлт шийдвэр хүлээж байна.",
  price_rejected: "Санал болгосон үнийг баталгаажуулах боломжгүй байна.",
  merchant_rejected: "Худалдаачин үнийн саналыг баталгаажуулах боломжгүй байна.",
  merchant_timeout: "Үнэ тохиролцох хүсэлтийн хариу өгөх хугацаа дууссан байна.",
  availability_changed: "Сэлбэг эсвэл засварын цагийн боломж өөрчлөгдсөн байна. Шинэ үнийн санал хүснэ үү.",
  invalid_price: "Үнийг бүхэл төгрөгөөр, эерэг дүнгээр бичнэ үү.",
};
type Decision = "accepted" | "countered" | "rejected";
type HumanResult = { outcome: "pending" | Decision; message?: string; quote?: Quote };

export class NegotiationStore {
  constructor(private readonly client: MongoClient, private readonly db: Db) {}

  private async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try {
      const result = await session.withTransaction(() => work(session), {
        readConcern: { level: "snapshot" }, writeConcern: { w: "majority" },
      });
      if (result === undefined) throw new Error("Үнэ тохиролцооны өөрчлөлтийг хадгалах боломжгүй байна.");
      return result;
    } finally {
      await session.endSession();
    }
  }

  private async lockRFQ(merchantId: string, rfqId: string, session: ClientSession): Promise<void> {
    await this.db.collection(guardCollection).updateOne({ merchantId, id: rfqId }, {
      $setOnInsert: { contractVersion: "1", merchantId, id: rfqId, createdAt: new Date().toISOString() },
      $inc: { version: 1 },
    }, { upsert: true, session });
  }

  private async audit(session: ClientSession, merchantId: string, actorId: string, actorKind: "buyer" | "merchant" | "system",
    action: "negotiation_requested" | "negotiation_decided" | "negotiation_timed_out", entityId: string,
    correlationId: string, outcome: "success" | "failure" = "success"): Promise<void> {
    const event = auditEventSchema.parse({ contractVersion: "1", id: randomUUID(), merchantId, createdAt: new Date().toISOString(),
      actorId, actorKind, action, entityId, correlationId, outcome });
    await this.db.collection("merchant_audit_events").insertOne(event, { session });
  }

  private async event(session: ClientSession, binding: TelegramBinding, negotiationId: string, updateId: number,
    action: "counter_drafted" | "accepted" | "countered" | "rejected", total?: Money): Promise<void> {
    const id = `te-${hash([binding.id, negotiationId, updateId, action]).slice(0, 40)}`;
    await this.db.collection(eventCollection).updateOne({ merchantId: binding.merchantId, id }, {
      $setOnInsert: { contractVersion: "1", id, merchantId: binding.merchantId, negotiationId, bindingId: binding.id,
        chatId: binding.chatId, userId: binding.userId, updateId, action, ...(total ? { total } : {}),
        createdAt: new Date().toISOString() },
    }, { session, upsert: true });
  }

  private response(request: NegotiationRequest, result: {
    outcome: "pending" | Decision; expiresAt: string; round: number; code?: NegotiationCode;
    quote?: Quote; serviceWindow?: { startsAt: string; endsAt: string }; message?: string;
  }): NegotiationResponse {
    const negotiation: Negotiation = { ...request.negotiation,
      status: result.outcome === "pending" ? "requested" : result.outcome,
      ...(result.quote ? { responseTotal: result.quote.total } : {}) };
    return negotiationResponseSchema.parse({ contractVersion: "1", merchantId: request.negotiation.merchantId,
      rfqId: request.rfqId, negotiationId: request.negotiation.id, correlationId: request.correlationId,
      negotiation, outcome: result.outcome, message: result.message ?? (result.code ? safeMessages[result.code] :
        result.outcome === "pending" ? "Үнэ тохиролцох хүсэлт худалдаачны шийдвэрийг хүлээж байна." :
          result.outcome === "accepted" ? "Худалдаачин үнийн саналыг зөвшөөрлөө." :
            result.outcome === "countered" ? "Худалдаачин өөр үнэ санал болголоо." : "Худалдаачин үнийн саналыг татгалзлаа."),
      expiresAt: result.expiresAt, round: result.round, ...(result.code ? { code: result.code } : {}),
      ...(result.quote ? { quote: result.quote } : {}), ...(result.serviceWindow ? { serviceWindow: result.serviceWindow } : {}) });
  }

  private async saveRejected(session: ClientSession, request: NegotiationRequest, expiresAt: string, round: number,
    code: NegotiationCode, requestHash: string, actorId: string): Promise<NegotiationResponse> {
    const response = this.response(request, { outcome: "rejected", expiresAt, round, code });
    await this.db.collection(recordCollection).insertOne({ ...response.negotiation }, { session });
    await this.db.collection(processingCollection).insertOne({ contractVersion: "1", merchantId: request.negotiation.merchantId,
      id: request.negotiation.id, rfqId: request.rfqId, buyerId: request.negotiation.buyerId,
      correlationId: request.correlationId, requestHash, request, telegramHandle: `ng-${randomBytes(20).toString("hex")}`,
      status: "rejected", expiresAt,
      response, round, createdAt: request.negotiation.createdAt, completedAt: new Date().toISOString() }, { session });
    await this.audit(session, request.negotiation.merchantId, actorId, "buyer", "negotiation_requested",
      request.negotiation.id, request.correlationId);
    await this.audit(session, request.negotiation.merchantId, "merchant-negotiation", "system", "negotiation_decided",
      request.negotiation.id, request.correlationId);
    return response;
  }

  private async saveResolved(session: ClientSession, document: Document, request: NegotiationRequest, outcome: Decision,
    quote?: Quote, actor?: { id: string; kind: "merchant" | "system" }, serviceWindow?: { startsAt: string; endsAt: string }): Promise<NegotiationResponse> {
    const response = this.response(request, { outcome, expiresAt: document.expiresAt, round: document.round,
      ...(quote ? { quote } : {}), ...(serviceWindow ? { serviceWindow } : {}),
      ...(outcome === "rejected" ? { code: "merchant_rejected" as const } : {}) });
    if (quote) {
      const originalQuote = quoteSchema.parse(domain(document.originalQuote));
      const changed = await this.db.collection("merchant_quotes").updateOne({ merchantId: originalQuote.merchantId,
        id: originalQuote.id, revision: originalQuote.revision, status: "offered" }, { $set: { status: "superseded" } }, { session });
      if (changed.matchedCount !== 1) throw new NegotiationStoreError("conflict");
      await this.db.collection("merchant_quotes").insertOne(structuredClone(quote), { session });
      await this.db.collection("merchant_quote_publications").insertOne({ contractVersion: "1", id: quote.id,
        merchantId: quote.merchantId, rfqId: quote.rfqId, buyerId: quote.buyerId, quoteId: quote.id,
        quoteRevision: quote.revision, source: "negotiated", status: "published",
        correlationId: request.correlationId, createdAt: quote.createdAt, ...(serviceWindow ? { serviceWindow } : {}) }, { session });
      await this.db.collection("merchant_rfqs").updateOne({ merchantId: quote.merchantId, id: quote.rfqId },
        { $set: { status: "quoted" } }, { session });
      await this.db.collection(processingCollection).updateOne({ merchantId: quote.merchantId, id: quote.rfqId },
        { $set: { currentQuoteId: quote.id, currentQuoteRevision: quote.revision } }, { session });
    }
    await this.db.collection(recordCollection).replaceOne({ merchantId: request.negotiation.merchantId, id: request.negotiation.id },
      response.negotiation, { session });
    await this.db.collection(processingCollection).updateOne({ merchantId: request.negotiation.merchantId,
      id: request.negotiation.id, status: "pending" }, { $set: { status: outcome, response,
        ...(quote ? { decisionQuoteId: quote.id, decisionQuoteRevision: quote.revision } : {}),
        completedAt: new Date().toISOString(), ...(actor ? { decidedBy: actor.id, decidedByKind: actor.kind } : {}) } }, { session });
    await this.audit(session, request.negotiation.merchantId, actor?.id ?? "merchant-negotiation",
      actor?.kind ?? "system", "negotiation_decided", request.negotiation.id, request.correlationId);
    return response;
  }

  async submit(merchantId: string, buyerId: string, input: unknown, retryAttempt = 0): Promise<NegotiationResponse> {
    const parsed = negotiateQuoteRequestSchema.safeParse(input);
    if (!parsed.success || !knownMerchant(merchantId) || !idSchema.safeParse(buyerId).success)
      throw new NegotiationStoreError("access_denied");
    const request = parsed.data;
    if (request.negotiation.merchantId !== merchantId || request.negotiation.buyerId !== buyerId)
      throw new NegotiationStoreError("access_denied");
    const requestHash = hash(request);
    try {
      return await this.transaction(async session => {
        await this.lockRFQ(merchantId, request.rfqId, session);
        const existing = await this.db.collection(processingCollection).findOne({ merchantId, id: request.negotiation.id }, { session });
        if (existing) {
          if (existing.requestHash !== requestHash || existing.rfqId !== request.rfqId || existing.buyerId !== buyerId)
            throw new NegotiationStoreError("conflict");
          return negotiationResponseSchema.parse(existing.response);
        }
        const rfqProcessing = await this.db.collection(RFQ_PROCESSING_COLLECTION)
          .findOne({ merchantId, id: request.rfqId, buyerId }, { session });
        if (!rfqProcessing || rfqProcessing.merchantId !== merchantId || rfqProcessing.buyerId !== buyerId)
          throw new NegotiationStoreError("access_denied");
        const envelope = rfqProcessing.envelope as MerchantRFQEnvelope;
        if (envelope.rfq?.merchantId !== merchantId || envelope.rfq?.buyerId !== buyerId ||
            envelope.rfq?.id !== request.rfqId || envelope.correlationId !== request.correlationId)
          throw new NegotiationStoreError("access_denied");
        const originalDocument = await this.db.collection("merchant_quotes").findOne({
          merchantId, rfqId: request.rfqId, id: request.negotiation.quoteId, revision: request.negotiation.quoteRevision,
          buyerId,
        }, { session });
        if (!originalDocument) throw new NegotiationStoreError("conflict");
        const originalQuote = quoteSchema.parse(domain(originalDocument));
        const now = new Date();
        const context = await loadScopedRFQContext(this.db, merchantId, request.rfqId, session, rfqProcessing);
        const settings = context.data.settings ? settingsSchema.parse(context.data.settings) : null;
        const timeout = settings?.negotiationTimeoutSeconds ?? 300;
        const deadline = Math.min(Date.parse(request.expiresAt), now.getTime() + timeout * 1000,
          Date.parse(originalQuote.expiresAt), Date.parse(envelope.expiresAt),
          envelope.rfq.requiredBy ? Date.parse(envelope.rfq.requiredBy) : Infinity);
        const expiresAt = new Date(Math.max(Date.parse(request.negotiation.createdAt) + 1, deadline)).toISOString();
        const rounds = await this.db.collection(processingCollection).countDocuments({ merchantId, rfqId: request.rfqId }, { session });
        const round = rounds + 1;
        const ruleFailure = (code: NegotiationCode) => this.saveRejected(session, request, expiresAt, round, code, requestHash, buyerId);
        if (Date.parse(originalQuote.expiresAt) <= now.getTime()) return ruleFailure("quote_expired");
        if (Date.parse(envelope.expiresAt) <= now.getTime() ||
            (envelope.rfq.requiredBy && Date.parse(envelope.rfq.requiredBy) <= now.getTime())) return ruleFailure("rfq_expired");
        if (Date.parse(expiresAt) <= now.getTime()) return ruleFailure("merchant_timeout");
        const latestDocuments = await this.db.collection("merchant_quotes").find({ merchantId, rfqId: request.rfqId }, { session })
          .sort({ revision: -1 }).limit(1).toArray();
        const latest = latestDocuments[0] ? quoteSchema.parse(domain(latestDocuments[0])) : null;
        if (!latest || latest.id !== originalQuote.id || latest.revision !== originalQuote.revision || latest.status !== "offered")
          return ruleFailure("stale_quote");
        if (!settings?.negotiationEnabled || round > (settings.maxNegotiationRounds ?? 3)) {
          return ruleFailure(settings?.negotiationEnabled ? "round_limit" : "negotiation_disabled");
        }
        if (await this.db.collection(processingCollection).findOne({ merchantId, rfqId: request.rfqId, status: "pending" }, { session }))
          return ruleFailure("negotiation_pending");

        const serviceWindow = (rfqProcessing.response as Document | undefined)?.serviceWindow as { startsAt: string; endsAt: string } | undefined;
        const humanRequired = settings.humanApprovalRequired || !settings.automaticNegotiationEnabled;
        const telegramHandle = `ng-${randomBytes(20).toString("hex")}`;
        const record = { contractVersion: "1", merchantId, id: request.negotiation.id, rfqId: request.rfqId,
          buyerId, correlationId: request.correlationId, requestHash, request, originalQuote,
          requestedTotal: request.negotiation.requestedTotal, proposedTotal: request.negotiation.requestedTotal,
          telegramHandle, status: "pending", expiresAt, round, createdAt: request.negotiation.createdAt,
          notificationStatus: humanRequired ? "pending" : "not_required", nextAttemptAt: now, notificationAttempts: 0 };
        if (humanRequired) {
          const response = this.response(request, { outcome: "pending", expiresAt, round,
            message: "Үнэ тохиролцох хүсэлт худалдаачны шийдвэрийг хүлээж байна." });
          await this.db.collection(recordCollection).insertOne({ ...request.negotiation }, { session });
          await this.db.collection(processingCollection).insertOne({ ...record, response }, { session });
          await this.audit(session, merchantId, buyerId, "buyer", "negotiation_requested", request.negotiation.id, request.correlationId);
          return response;
        }
        let priced;
        try {
          priced = priceNegotiatedQuote(context.data, originalQuote, envelope, request.negotiation.requestedTotal, now,
            originalQuote.revision + 1, { ...(serviceWindow ? { serviceWindow } : {}), expiresAt });
        } catch (error) {
          if (error instanceof NegotiationRuleError) return ruleFailure(error.kind);
          throw error;
        }
        const response = this.response(request, { outcome: priced.outcome, expiresAt, round, quote: priced.quote,
          ...(priced.serviceWindow ? { serviceWindow: priced.serviceWindow } : {}) });
        await this.db.collection(recordCollection).insertOne({ ...response.negotiation }, { session });
        await this.db.collection(processingCollection).insertOne({ ...record, status: priced.outcome,
          response, decisionQuoteId: priced.quote.id, decisionQuoteRevision: priced.quote.revision,
          completedAt: new Date().toISOString() }, { session });
        const superseded = await this.db.collection("merchant_quotes").updateOne({ merchantId, id: originalQuote.id,
          revision: originalQuote.revision, status: "offered" }, { $set: { status: "superseded" } }, { session });
        if (superseded.matchedCount !== 1) throw new NegotiationStoreError("conflict");
        await this.db.collection("merchant_quotes").insertOne(structuredClone(priced.quote), { session });
        await this.db.collection("merchant_quote_publications").insertOne({ contractVersion: "1", id: priced.quote.id,
          merchantId, rfqId: request.rfqId, buyerId, quoteId: priced.quote.id, quoteRevision: priced.quote.revision,
          source: "negotiated", status: "published", correlationId: request.correlationId,
          createdAt: priced.quote.createdAt, ...(priced.serviceWindow ? { serviceWindow: priced.serviceWindow } : {}) }, { session });
        await this.db.collection("merchant_rfqs").updateOne({ merchantId, id: request.rfqId }, { $set: { status: "quoted" } }, { session });
        await this.db.collection(RFQ_PROCESSING_COLLECTION).updateOne({ merchantId, id: request.rfqId },
          { $set: { currentQuoteId: priced.quote.id, currentQuoteRevision: priced.quote.revision } }, { session });
        await this.audit(session, merchantId, buyerId, "buyer", "negotiation_requested", request.negotiation.id, request.correlationId);
        await this.audit(session, merchantId, "merchant-negotiation", "system", "negotiation_decided", request.negotiation.id, request.correlationId);
        return response;
      });
    } catch (error) {
      if (duplicateKey(error)) {
        const existing = await this.db.collection(processingCollection).findOne({ merchantId, id: request.negotiation.id });
        if (existing && existing.requestHash === requestHash) return negotiationResponseSchema.parse(existing.response);
        if (!existing && retryAttempt < 2) return this.submit(merchantId, buyerId, request, retryAttempt + 1);
        throw new NegotiationStoreError("conflict");
      }
      if (error instanceof ScopedRFQDataError) throw new NegotiationStoreError("access_denied");
      throw error;
    }
  }

  async getResult(merchantId: string, buyerId: string, rfqId: string, negotiationId: string): Promise<NegotiationResponse> {
    if (!knownMerchant(merchantId) || !idSchema.safeParse(buyerId).success ||
        !idSchema.safeParse(rfqId).success || !idSchema.safeParse(negotiationId).success)
      throw new NegotiationStoreError("access_denied");
    const existing = await this.db.collection(processingCollection)
      .findOne({ merchantId, id: negotiationId, rfqId, buyerId });
    if (!existing) throw new NegotiationStoreError("access_denied");
    if (existing.status === "pending" && Date.parse(existing.expiresAt) <= Date.now()) {
      await this.expireOne(merchantId, negotiationId);
      const expired = await this.db.collection(processingCollection).findOne({ merchantId, id: negotiationId, rfqId, buyerId });
      if (expired) return negotiationResponseSchema.parse(expired.response);
    }
    return negotiationResponseSchema.parse(existing.response);
  }

  private checkedBinding(input: TelegramBinding): TelegramBinding {
    if (!knownMerchant(input.merchantId) || !input.active || input.chatId !== input.userId ||
        !telegramIdentitySchema.safeParse(input.chatId).success || !telegramIdentitySchema.safeParse(input.userId).success ||
        !idSchema.safeParse(input.id).success || !["demo", "production"].includes(input.mode))
      throw new NegotiationStoreError("access_denied");
    return input;
  }

  private async lockBinding(input: TelegramBinding, session: ClientSession): Promise<TelegramBinding> {
    const binding = this.checkedBinding(input);
    const result = await this.db.collection("merchant_telegram_bindings").findOneAndUpdate({
      id: binding.id, merchantId: binding.merchantId, chatId: binding.chatId, userId: binding.userId,
      mode: binding.mode, active: true,
    }, { $inc: { operationVersion: 1 } }, { session, returnDocument: "after" });
    if (!result) throw new NegotiationStoreError("access_denied");
    return this.checkedBinding({ id: result.id, merchantId: result.merchantId, chatId: result.chatId,
      userId: result.userId, mode: result.mode, active: result.active });
  }

  private async humanRecord(binding: TelegramBinding, handle: string, session: ClientSession): Promise<Document> {
    if (!handlePattern.test(handle)) throw new NegotiationStoreError("access_denied");
    const record = await this.db.collection(processingCollection).findOne({
      merchantId: binding.merchantId, telegramHandle: handle, notificationBindingId: binding.id,
    }, { session });
    if (!record || record.merchantId !== binding.merchantId || record.notificationBindingId !== binding.id)
      throw new NegotiationStoreError("access_denied");
    return record;
  }

  private async expireRecord(session: ClientSession, record: Document): Promise<void> {
    const request = negotiateQuoteRequestSchema.parse(record.request);
    const result = this.response(request, { outcome: "rejected", expiresAt: record.expiresAt, round: record.round,
      code: "merchant_timeout" });
    await this.db.collection(recordCollection).updateOne({ merchantId: record.merchantId, id: record.id },
      { $set: result.negotiation }, { session });
    await this.db.collection(processingCollection).updateOne({ merchantId: record.merchantId, id: record.id, status: "pending" },
      { $set: { status: "rejected", response: result, completedAt: new Date().toISOString(), notificationStatus: "expired" } }, { session });
    await this.audit(session, record.merchantId, "merchant-negotiation", "system", "negotiation_timed_out", record.id, record.correlationId);
  }

  private async currentHumanResult(binding: TelegramBinding, record: Document, session: ClientSession): Promise<HumanResult> {
    if (record.status === "pending" && Date.parse(record.expiresAt) <= Date.now()) {
      await this.expireRecord(session, record);
      const updated = await this.db.collection(processingCollection).findOne({ merchantId: binding.merchantId, id: record.id }, { session });
      return { outcome: "rejected", message: safeMessages.merchant_timeout, ...(updated?.response?.quote ? { quote: updated.response.quote } : {}) };
    }
    const response = negotiationResponseSchema.parse(record.response);
    return { outcome: response.outcome, message: response.message, ...(response.quote ? { quote: response.quote } : {}) };
  }

  async getHumanContext(bindingInput: TelegramBinding, handle: string) {
    const checked = this.checkedBinding(bindingInput);
    return this.transaction(async session => {
      const binding = await this.lockBinding(checked, session);
      const record = await this.humanRecord(binding, handle, session);
      const result = await this.currentHumanResult(binding, record, session);
      return { telegramHandle: record.telegramHandle, rfqId: record.rfqId, negotiationId: record.id,
        expiresAt: record.expiresAt, originalQuote: quoteSchema.parse(domain(record.originalQuote)),
        requestedTotal: record.requestedTotal, proposedTotal: record.proposedTotal, response: result,
        ...(record.counterDraft ? { counterDraft: { total: record.counterDraft.total, updateId: record.counterDraft.updateId,
          bindingId: record.counterDraft.bindingId } } : {}) };
    });
  }

  async prepareHumanCounter(bindingInput: TelegramBinding, handle: string, total: Money, updateId: number) {
    const checked = this.checkedBinding(bindingInput);
    if (!Number.isSafeInteger(updateId) || updateId < 0) throw new NegotiationStoreError("stale_counter");
    return this.transaction(async session => {
      const binding = await this.lockBinding(checked, session);
      const record = await this.humanRecord(binding, handle, session);
      const response = await this.currentHumanResult(binding, record, session);
      if (response.outcome !== "pending") return { response, updateId };
      const existing = record.counterDraft as { total: Money; updateId: number; bindingId: string } | undefined;
      if (existing && updateId === existing.updateId) {
        if (canonical(existing.total) !== canonical(total) || existing.bindingId !== binding.id)
          throw new NegotiationStoreError("conflict");
        return { response, updateId };
      }
      if (existing && updateId < existing.updateId) throw new NegotiationStoreError("stale_counter");
      const { envelope, data } = await loadScopedRFQContext(this.db, binding.merchantId, record.rfqId, session);
      const window = (await this.db.collection(RFQ_PROCESSING_COLLECTION).findOne({
        merchantId: binding.merchantId, id: record.rfqId,
      }, { session }))?.response?.serviceWindow;
      try {
        const originalQuote = quoteSchema.parse(domain(record.originalQuote));
        validateHumanNegotiationPrice(data, originalQuote, envelope, total, new Date(), originalQuote.revision + 1,
          { ...(window ? { serviceWindow: window } : {}), expiresAt: record.expiresAt });
      } catch (error) {
        if (error instanceof NegotiationRuleError) {
          await this.event(session, binding, record.id, updateId, "counter_drafted", total);
          throw error;
        }
        throw error;
      }
      await this.db.collection(processingCollection).updateOne({ merchantId: binding.merchantId, id: record.id, status: "pending" },
        { $set: { counterDraft: { total, updateId, bindingId: binding.id }, counterDraftUpdatedAt: new Date().toISOString() } }, { session });
      await this.event(session, binding, record.id, updateId, "counter_drafted", total);
      return { response, updateId };
    });
  }

  async decideHuman(bindingInput: TelegramBinding, handle: string, decision: "accept" | "counter" | "reject",
    counterVersion?: number): Promise<HumanResult> {
    const checked = this.checkedBinding(bindingInput);
    return this.transaction(async session => {
      const binding = await this.lockBinding(checked, session);
      const record = await this.humanRecord(binding, handle, session);
      const result = await this.currentHumanResult(binding, record, session);
      if (result.outcome !== "pending") return result;
      const request = negotiateQuoteRequestSchema.parse(record.request);
      const context = await loadScopedRFQContext(this.db, binding.merchantId, record.rfqId, session);
      const originalQuote = quoteSchema.parse(domain(record.originalQuote));
      const latest = await this.db.collection("merchant_quotes").findOne({ merchantId: binding.merchantId,
        rfqId: record.rfqId, status: "offered" }, { session });
      if (!latest || latest.id !== originalQuote.id || latest.revision !== originalQuote.revision)
        throw new NegotiationStoreError("conflict");
      const processing = await this.db.collection(RFQ_PROCESSING_COLLECTION).findOne({ merchantId: binding.merchantId,
        id: record.rfqId }, { session });
      const serviceWindow = processing?.response?.serviceWindow as { startsAt: string; endsAt: string } | undefined;
      const now = new Date();
      let finalOutcome: Decision;
      let quote: Quote | undefined;
      if (decision === "reject") {
        finalOutcome = "rejected";
        await this.event(session, binding, record.id, counterVersion ?? 0, "rejected");
      } else {
        let total: Money;
        if (decision === "accept") {
          total = request.negotiation.requestedTotal;
          finalOutcome = "accepted";
        } else {
          const draft = record.counterDraft as { total: Money; updateId: number; bindingId: string } | undefined;
          if (!draft || draft.bindingId !== binding.id || draft.updateId !== counterVersion)
            throw new NegotiationStoreError("stale_counter");
          total = draft.total;
          finalOutcome = "countered";
        }
        try {
          const priced = validateHumanNegotiationPrice(context.data, originalQuote, context.envelope, total, now,
            originalQuote.revision + 1, { ...(serviceWindow ? { serviceWindow } : {}), expiresAt: record.expiresAt });
          quote = priced.quote;
        } catch (error) {
          if (error instanceof NegotiationRuleError) throw error;
          throw error;
        }
        await this.event(session, binding, record.id, counterVersion ?? 0, decision === "accept" ? "accepted" : "countered", total);
      }
      const response = await this.saveResolved(session, record, request, finalOutcome, quote,
        { id: `telegram-${binding.userId}`, kind: "merchant" }, quote && serviceWindow ? serviceWindow : undefined);
      return { outcome: response.outcome, message: response.message, ...(response.quote ? { quote: response.quote } : {}) };
    });
  }

  private async expireOne(merchantId: string, negotiationId: string): Promise<boolean> {
    return this.transaction(async session => {
      const record = await this.db.collection(processingCollection).findOne({ merchantId, id: negotiationId, status: "pending" }, { session });
      if (!record || Date.parse(record.expiresAt) > Date.now()) return false;
      await this.lockRFQ(merchantId, record.rfqId, session);
      await this.expireRecord(session, record);
      return true;
    });
  }

  async expirePending(limit = 50): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError("Хугацаа дууссан хүсэлтийн тоо буруу байна.");
    const expired = await this.db.collection(processingCollection).find({ status: "pending", expiresAt: { $lte: new Date().toISOString() } })
      .sort({ expiresAt: 1 }).limit(limit).toArray();
    let count = 0;
    for (const record of expired) if (await this.expireOne(record.merchantId, record.id)) count++;
    return count;
  }
}
