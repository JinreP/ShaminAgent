import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ClientSession, Db, Document, MongoClient } from "mongodb";
import { z } from "zod";
import { auditEventSchema, idSchema, quoteSchema, type Quote } from "../../shared/merchant-contracts";
import { DEMO_MERCHANTS } from "../demo-merchants";
import { inventorySchema, serviceSchema, settingsSchema } from "../private-contracts";
import { merchantName } from "../i18n";
import {
  approvalIntentRequestSchema, availabilityResultSchema, commerceApprovalSchema, commerceTransactionSchema,
  mockPaymentSchema, partsOrderSchema, quoteSelectionSchema, repairBookingSchema,
  type AvailabilityResult, type BookingTerms, type CommerceApproval, type QuoteSelection,
} from "./contracts";

const approvals = "merchant_commerce_approvals";
const transactions = "merchant_commerce_transactions";
const orders = "merchant_parts_orders";
const bookings = "merchant_repair_bookings";
const inventoryReservations = "merchant_inventory_reservations";
const slotReservations = "merchant_slot_reservations";
const slotCounters = "merchant_slot_reservation_counters";
const payments = "merchant_mock_payments";
const compensations = "merchant_compensation_attempts";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const discountedWholeMntFloor = (amountMinor: number, maxDiscountBps: number) => {
  const discountedMinor = (BigInt(amountMinor) * BigInt(10000 - maxDiscountBps) + BigInt(9999)) / BigInt(10000);
  return ((discountedMinor + BigInt(99)) / BigInt(100)) * BigInt(100);
};
const domain = (record: Document) => {
  const { _id, _version, ...value } = record; void _id; void _version; return value;
};
const duplicateKey = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === 11000);
const isMerchant = (id: string) => DEMO_MERCHANTS.some(merchant => merchant.id === id);
const safeAmount = (value: bigint) => {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new CommerceStoreError("invalid");
  return Number(value);
};

export class CommerceStoreError extends Error {
  constructor(readonly code: "unauthorized" | "not_found" | "invalid" | "stale" | "expired" | "unavailable" |
    "conflict" | "already_paid" | "recovery_required") {
    const messages = {
      unauthorized: "Энэ худалдааны үйлдэлд хандах эрхгүй байна.",
      not_found: "Худалдааны бүртгэл олдсонгүй.",
      invalid: "Худалдааны хүсэлтийн талбар буруу байна.",
      stale: "Үнийн санал өөрчлөгдсөн байна. Шинэ нөхцөлийг дахин шалгаж, зөвшөөрнө үү.",
      expired: "Зөвшөөрөл эсвэл үнийн саналын хугацаа дууссан байна.",
      unavailable: "Бараа эсвэл засварын цаг одоогоор боломжгүй байна.",
      conflict: "Давхардсан хүсэлтийн мэдээлэл зөрж байна.",
      already_paid: "Төлбөрийн туршилт өмнө нь шийдвэрлэгдсэн байна.",
      recovery_required: "Захиалгын хэсгийг сэргээхэд нэмэлт шалгалт шаардлагатай байна.",
    } as const;
    super(messages[code]);
    this.name = "CommerceStoreError";
  }
}

export type ApprovalCreated = { approvalId: string; transactionId: string; approvalUrl: string; expiresAt: string; total: number };

export class CommerceStore {
  constructor(private readonly client: MongoClient, private readonly db: Db, private readonly approvalOrigin = "http://localhost") {
    let origin: URL;
    try { origin = new URL(approvalOrigin); } catch { throw new CommerceStoreError("invalid"); }
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
        !["http:", "https:"].includes(origin.protocol) ||
        (origin.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) {
      throw new CommerceStoreError("invalid");
    }
  }

  private async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(() => work(session), {
        readConcern: { level: "snapshot" }, writeConcern: { w: "majority" },
      });
    } finally {
      await session.endSession();
    }
  }

  private async audit(session: ClientSession, merchantId: string, actorId: string, action: "approval_verified" | "approval_revoked" |
    "transaction_created" | "transaction_updated", entityId: string, correlationId: string, outcome: "success" | "failure" = "success") {
    const event = auditEventSchema.parse({ contractVersion: "1", id: randomUUID(), merchantId, createdAt: new Date().toISOString(),
      actorId, actorKind: actorId.startsWith("buyer-") ? "buyer" : actorId.startsWith("merchant-") ? "merchant" : "system",
      action, entityId, correlationId, outcome });
    await this.db.collection("merchant_audit_events").insertOne(event, { session });
  }

  private async selectedQuotes(selections: QuoteSelection[], buyerId: string, session?: ClientSession): Promise<Quote[]> {
    const quotes: Quote[] = [];
    const ids = new Set<string>();
    for (const selection of selections) {
      quoteSelectionSchema.parse(selection);
      if (!isMerchant(selection.merchantId) || ids.has(`${selection.merchantId}:${selection.quoteId}:${selection.quoteRevision}`))
        throw new CommerceStoreError("invalid");
      ids.add(`${selection.merchantId}:${selection.quoteId}:${selection.quoteRevision}`);
      const query = { merchantId: selection.merchantId, id: selection.quoteId, revision: selection.quoteRevision, buyerId };
      const document = await this.db.collection("merchant_quotes").findOne(query, session ? { session } : {});
      if (!document) throw new CommerceStoreError("not_found");
      const quote = quoteSchema.parse(domain(document));
      const latest = await this.db.collection("merchant_quotes").findOne({ merchantId: quote.merchantId, rfqId: quote.rfqId },
        { sort: { revision: -1 }, ...(session ? { session } : {}) });
      if (quote.status !== "offered" || !latest || latest.id !== quote.id || latest.revision !== quote.revision)
        throw new CommerceStoreError("stale");
      if (Date.parse(quote.expiresAt) <= Date.now()) throw new CommerceStoreError("expired");
      if (quote.mode !== "simulated" || quote.total.currency !== "MNT" || quote.total.amountMinor % 100 !== 0 ||
          quote.lines.some(line => line.unitPrice.currency !== "MNT" || line.unitPrice.amountMinor % 100 !== 0))
        throw new CommerceStoreError("invalid");
      quotes.push(quote);
    }
    return quotes;
  }

  private total(quotes: Quote[]): number {
    return safeAmount(quotes.reduce((sum, quote) => sum + BigInt(quote.total.amountMinor), BigInt(0)));
  }

  private async checkAvailabilityInternal(selections: QuoteSelection[], buyerId: string, session?: ClientSession,
    ownTransactionId?: string): Promise<AvailabilityResult> {
    const checkedAt = new Date().toISOString();
    const quotes = await this.selectedQuotes(selections, buyerId, session);
    const issues: string[] = [], windows: BookingTerms[] = [];
    for (const quote of quotes) {
      if (quote.kind === "parts") {
        for (const line of quote.lines) {
          const resourceDocument = await this.db.collection("merchant_inventory").findOne({
            merchantId: quote.merchantId, id: line.resourceId, active: true,
          }, session ? { session } : {});
          if (!resourceDocument) { issues.push("Барааны мэдээлэл эсвэл нөөц өөрчлөгдсөн байна."); continue; }
          const resource = inventorySchema.parse(domain(resourceDocument));
          if (resource.price.currency !== "MNT" || resource.minimumPrice.currency !== "MNT" ||
              resource.price.amountMinor % 100 !== 0 || resource.minimumPrice.amountMinor % 100 !== 0) {
            issues.push("Сэлбэгийн үнэ төгрөгийн бүхэл дүн биш байна.");
            continue;
          }
          const reserved = ownTransactionId ? await this.db.collection(inventoryReservations).findOne({
            merchantId: quote.merchantId, transactionId: ownTransactionId, resourceId: line.resourceId, status: "reserved",
          }, session ? { session } : {}) : null;
          if (resource.stock + Number(reserved?.quantity ?? 0) < line.quantity)
            issues.push("Сэлбэгийн үлдэгдэл баталгаажуулахад хүрэлцэхгүй байна.");
          const publication = await this.db.collection("merchant_quote_publications").findOne({
            merchantId: quote.merchantId, quoteId: quote.id, quoteRevision: quote.revision, status: "published",
          }, session ? { session } : {});
          if (publication?.source === "negotiated") {
            const policyDoc = await this.db.collection("merchant_settings").findOne({ merchantId: quote.merchantId, id: quote.merchantId },
              session ? { session } : {});
            const policy = policyDoc ? settingsSchema.parse(domain(policyDoc)) : null;
            const minimum = BigInt(resource.minimumPrice.amountMinor);
            const discountFloor = discountedWholeMntFloor(resource.price.amountMinor, policy?.maxDiscountBps ?? 0);
            if (!policy?.negotiationEnabled || BigInt(line.unitPrice.amountMinor) < (minimum > discountFloor ? minimum : discountFloor))
              issues.push("Худалдаачны одоогийн үнийн хязгаарт санал нийцэхгүй байна.");
          } else if (resource.price.amountMinor !== line.unitPrice.amountMinor) {
            issues.push("Сэлбэгийн үнэ үнийн саналаас өөрчлөгдсөн байна.");
          }
        }
      } else {
        const slotDoc = await this.db.collection("merchant_quote_publications").findOne({
          merchantId: quote.merchantId, quoteId: quote.id, quoteRevision: quote.revision, status: "published",
        }, session ? { session } : {});
        const slotResponse = slotDoc?.serviceWindow ?? (await this.db.collection("merchant_rfq_processing").findOne({
          merchantId: quote.merchantId, id: quote.rfqId,
        }, session ? { session } : {}))?.response?.serviceWindow;
        if (!slotResponse) { issues.push("Засварын хүчинтэй цагийн хуваарь олдсонгүй."); continue; }
        const slot = await this.db.collection("merchant_slots").findOne({
          merchantId: quote.merchantId, startsAt: slotResponse.startsAt, endsAt: slotResponse.endsAt, status: "available",
        }, session ? { session } : {});
        if (!slot || Date.parse(slot.endsAt) <= Date.now() ||
            quote.lines.some(line => !slot.serviceIds?.includes(line.resourceId)))
          issues.push("Засварын цаг өөрчлөгдсөн эсвэл боломжгүй байна.");
        else {
          const counter = await this.db.collection(slotCounters).findOne({ merchantId: quote.merchantId, id: slot.id }, session ? { session } : {});
          if (Number(counter?.count ?? 0) >= slot.capacity) issues.push("Засварын цагийн багтаамж дүүрсэн байна.");
          else windows.push({ merchantId: quote.merchantId, startsAt: slot.startsAt, endsAt: slot.endsAt,
            customerSuppliedParts: quote.terms.includes("Захиалагчийн") });
        }
        for (const line of quote.lines) {
          const serviceDoc = await this.db.collection("merchant_services").findOne({
            merchantId: quote.merchantId, id: line.resourceId, active: true,
          }, session ? { session } : {});
          if (!serviceDoc) { issues.push("Засварын үйлчилгээ идэвхгүй болсон байна."); continue; }
          const service = serviceSchema.parse(domain(serviceDoc));
          if (service.price.currency !== "MNT" || service.minimumPrice.currency !== "MNT" ||
              service.price.amountMinor % 100 !== 0 || service.minimumPrice.amountMinor % 100 !== 0) {
            issues.push("Засварын үнэ төгрөгийн бүхэл дүн биш байна.");
            continue;
          }
          const publication = await this.db.collection("merchant_quote_publications").findOne({
            merchantId: quote.merchantId, quoteId: quote.id, quoteRevision: quote.revision, status: "published",
          }, session ? { session } : {});
          if (publication?.source === "negotiated") {
            const policyDoc = await this.db.collection("merchant_settings").findOne({ merchantId: quote.merchantId, id: quote.merchantId },
              session ? { session } : {});
            const policy = policyDoc ? settingsSchema.parse(domain(policyDoc)) : null;
            const minimum = BigInt(service.minimumPrice.amountMinor);
            const discountFloor = discountedWholeMntFloor(service.price.amountMinor, policy?.maxDiscountBps ?? 0);
            if (!policy?.negotiationEnabled || BigInt(line.unitPrice.amountMinor) < (minimum > discountFloor ? minimum : discountFloor))
              issues.push("Засварын үнэ худалдаачны одоогийн үнийн хязгаарт нийцэхгүй байна.");
          } else if (service.price.amountMinor !== line.unitPrice.amountMinor) {
            issues.push("Засварын үнэ үнийн саналаас өөрчлөгдсөн байна.");
          }
        }
      }
    }
    const total = this.total(quotes);
    return availabilityResultSchema.parse({ available: issues.length === 0, checkedAt, quotes, total: { amountMinor: total, currency: "MNT" as const },
      issues: [...new Set(issues)], bookingWindows: windows });
  }

  async checkAvailability(selections: QuoteSelection[], buyerId: string, merchantIds: string[]): Promise<AvailabilityResult> {
    for (const selection of selections) {
      if (!merchantIds.includes(selection.merchantId)) throw new CommerceStoreError("unauthorized");
    }
    return this.transaction(session => this.checkAvailabilityInternal(selections, buyerId, session));
  }

  async createApproval(input: unknown, buyerId: string, merchantIds: string[]): Promise<ApprovalCreated> {
    const request = approvalIntentRequestSchema.parse(input);
    if (request.selections.some(selection => !merchantIds.includes(selection.merchantId)))
      throw new CommerceStoreError("unauthorized");
    const approvalId = `ap-${randomUUID()}`;
    const challenge = randomBytes(32).toString("base64url");
    const createdAt = new Date(), availability = await this.checkAvailability(request.selections, buyerId, merchantIds);
    if (!availability.available || availability.total.amountMinor !== request.approvedTotal.amountMinor)
      throw new CommerceStoreError(availability.available ? "stale" : "unavailable");
    const quoteDeadline = Math.min(...availability.quotes.map(quote => Date.parse(quote.expiresAt)));
    const deadline = Math.min(Date.parse(request.expiresAt), Date.now() + 10 * 60_000, quoteDeadline);
    if (deadline <= Date.now()) throw new CommerceStoreError("expired");
    const merchantIdsSelected = [...new Set(availability.quotes.map(quote => quote.merchantId))];
    const repairQuotes = availability.quotes.filter(quote => quote.kind === "repair");
    if (repairQuotes.length && (!request.booking || repairQuotes.length !== 1 ||
        request.booking.merchantId !== repairQuotes[0].merchantId ||
        !availability.bookingWindows.some(window => window.merchantId === request.booking!.merchantId &&
          window.startsAt === request.booking!.startsAt && window.endsAt === request.booking!.endsAt))) {
      throw new CommerceStoreError("stale");
    }
    if (request.booking) {
      const repairQuote = repairQuotes[0];
      for (const line of repairQuote.lines) {
        const serviceDoc = await this.db.collection("merchant_services").findOne({
          merchantId: repairQuote.merchantId, id: line.resourceId, active: true,
        });
        if (!serviceDoc) throw new CommerceStoreError("unavailable");
        const service = serviceSchema.parse(domain(serviceDoc));
        if (request.booking.customerSuppliedParts && service.customerSuppliedParts === "not_accepted")
          throw new CommerceStoreError("invalid");
      }
    }
    if (!repairQuotes.length && request.booking) throw new CommerceStoreError("invalid");
    const intent: CommerceApproval = commerceApprovalSchema.parse({ contractVersion: "1", id: approvalId,
      merchantId: merchantIdsSelected[0], merchantIds: merchantIdsSelected, buyerId,
      transactionId: request.transactionId, selections: request.selections, approvedTotal: request.approvedTotal,
      ...(request.booking ? { booking: request.booking } : {}), status: "pending", createdAt: createdAt.toISOString(),
      expiresAt: new Date(deadline).toISOString(), challengeHash: hash(challenge) });
    const quoteKinds = new Set(availability.quotes.map(quote => quote.kind));
    const transactionKind = quoteKinds.size > 1 ? "parts_and_repair" :
      quoteKinds.has("parts") ? "parts_order" : "repair_booking";
    const transaction = commerceTransactionSchema.parse({
      contractVersion: "1", id: request.transactionId, merchantId: intent.merchantId, createdAt: createdAt.toISOString(),
      buyerId, quoteId: availability.quotes[0].id, quoteRevision: availability.quotes[0].revision,
      approvalId, idempotencyKey: request.transactionId, kind: transactionKind,
      total: request.approvedTotal, mode: "simulated", paymentMode: "mock", status: "approval_pending",
      availabilityCheckedAt: availability.checkedAt, quoteSelections: request.selections, orderIds: [], bookingIds: [],
      progress: "awaiting_approval", updatedAt: createdAt.toISOString(),
    });
    try {
      await this.transaction(async session => {
        const existing = await this.db.collection(approvals).findOne({ merchantId: intent.merchantId, transactionId: intent.transactionId }, { session });
        if (existing) throw new CommerceStoreError("conflict");
        await this.db.collection(approvals).insertOne(intent, { session });
        await this.db.collection(transactions).insertOne(transaction, { session });
        await this.audit(session, intent.merchantId, `buyer-${buyerId}`, "transaction_created", transaction.id, approvalId);
      });
    } catch (error) {
      if (duplicateKey(error)) throw new CommerceStoreError("conflict");
      throw error;
    }
    return { approvalId, transactionId: request.transactionId,
      approvalUrl: `${this.approvalOrigin.replace(/\/$/, "")}/merchant/approval/${challenge}`,
      expiresAt: intent.expiresAt, total: intent.approvedTotal.amountMinor };
  }

  async approvalPage(challenge: string): Promise<{
    approvalId: string; page: Document; merchantId: string;
  }> {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(challenge)) throw new CommerceStoreError("not_found");
    const document = await this.db.collection(approvals).findOne({ challengeHash: hash(challenge) });
    if (!document) throw new CommerceStoreError("not_found");
    const approval = commerceApprovalSchema.parse(domain(document));
    const quotes: Quote[] = [];
    for (const selection of approval.selections) {
      const quoteDocument = await this.db.collection("merchant_quotes").findOne({
        merchantId: selection.merchantId, id: selection.quoteId, revision: selection.quoteRevision, buyerId: approval.buyerId,
      });
      if (!quoteDocument) throw new CommerceStoreError("not_found");
      quotes.push(quoteSchema.parse(domain(quoteDocument)));
    }
    const status = approval.status === "pending" && Date.parse(approval.expiresAt) <= Date.now() ? "expired" : approval.status;
    const page = {
      transactionId: approval.transactionId,
      merchantNames: approval.merchantIds.map(merchantName),
      total: approval.approvedTotal, ...(approval.booking ? { booking: approval.booking } : {}),
      expiresAt: approval.expiresAt, status,
      quoteSummaries: quotes.map(quote => ({ merchantName: merchantName(quote.merchantId), quoteId: quote.id,
        revision: quote.revision, kind: quote.kind, terms: quote.terms })),
    };
    return { approvalId: approval.id, page, merchantId: approval.merchantId };
  }

  async approveByChallenge(challenge: string, action: "approve" | "reject"): Promise<void> {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(challenge)) throw new CommerceStoreError("not_found");
    const challengeHash = hash(challenge);
    await this.transaction(async session => {
      const document = await this.db.collection(approvals).findOne({ challengeHash }, { session });
      if (!document) throw new CommerceStoreError("not_found");
      const approval = commerceApprovalSchema.parse(domain(document));
      if (approval.status !== "pending") throw new CommerceStoreError("conflict");
      if (Date.parse(approval.expiresAt) <= Date.now()) throw new CommerceStoreError("expired");
      if (action === "approve") {
        const availability = await this.checkAvailabilityInternal(approval.selections, approval.buyerId, session);
        if (!availability.available || availability.total.amountMinor !== approval.approvedTotal.amountMinor)
          throw new CommerceStoreError("stale");
      }
      const now = new Date().toISOString();
      if (action === "approve") {
        const verificationReference = `demo-${randomUUID()}`;
        const updatedApproval = await this.db.collection(approvals).updateOne({ merchantId: approval.merchantId, id: approval.id, status: "pending" },
          { $set: { status: "verified", verifiedAt: now, verificationReference, challengeHash: hash(randomBytes(32).toString("hex")) } }, { session });
        if (updatedApproval.matchedCount !== 1) throw new CommerceStoreError("conflict");
        const updatedTransaction = await this.db.collection(transactions).updateOne({ merchantId: approval.merchantId, id: approval.transactionId,
          status: "approval_pending" }, { $set: { status: "approved", progress: "processing", updatedAt: now } }, { session });
        if (updatedTransaction.matchedCount !== 1) throw new CommerceStoreError("conflict");
        await this.audit(session, approval.merchantId, `buyer-${approval.buyerId}`, "approval_verified", approval.id, approval.transactionId);
      } else {
        const updatedApproval = await this.db.collection(approvals).updateOne({ merchantId: approval.merchantId, id: approval.id, status: "pending" },
          { $set: { status: "revoked", challengeHash: hash(randomBytes(32).toString("hex")) } }, { session });
        if (updatedApproval.matchedCount !== 1) throw new CommerceStoreError("conflict");
        const updatedTransaction = await this.db.collection(transactions).updateOne({ merchantId: approval.merchantId, id: approval.transactionId,
          status: "approval_pending" }, { $set: { status: "cancelled", progress: "cancelled", updatedAt: now } }, { session });
        if (updatedTransaction.matchedCount !== 1) throw new CommerceStoreError("conflict");
        await this.audit(session, approval.merchantId, `buyer-${approval.buyerId}`, "approval_revoked", approval.id, approval.transactionId);
      }
    });
  }

  private async approvalFor(approvalId: string, transactionId: string, buyerId: string, merchantIds: string[],
    session: ClientSession, allowExpired = false): Promise<CommerceApproval> {
    idSchema.parse(approvalId); idSchema.parse(transactionId);
    const document = await this.db.collection(approvals).findOne({ id: approvalId, transactionId, buyerId, status: "verified" }, { session });
    if (!document) throw new CommerceStoreError("unauthorized");
    const approval = commerceApprovalSchema.parse(domain(document));
    if (approval.merchantIds.some(id => !merchantIds.includes(id))) throw new CommerceStoreError("unauthorized");
    if (!allowExpired && Date.parse(approval.expiresAt) <= Date.now()) throw new CommerceStoreError("expired");
    return approval;
  }

  async createPartsOrder(input: { transactionId: string; approvalId: string; idempotencyKey: string }, buyerId: string, merchantIds: string[]) {
    const parsed = z.object({ transactionId: idSchema, approvalId: idSchema, idempotencyKey: idSchema }).strict().parse(input);
    try {
      return await this.transaction(async session => {
        const approval = await this.approvalFor(parsed.approvalId, parsed.transactionId, buyerId, merchantIds, session);
        if (approval.transactionId !== parsed.idempotencyKey || approval.id !== parsed.approvalId)
          throw new CommerceStoreError("conflict");
        const prior = await this.db.collection(orders).find({ transactionId: parsed.transactionId }, { session }).toArray();
        if (prior.length) {
          if (prior.some(order => order.approvalId !== approval.id)) throw new CommerceStoreError("conflict");
          return { orders: prior.map(order => partsOrderSchema.parse(domain(order))) };
        }
        const quotes = await this.selectedQuotes(approval.selections, buyerId, session);
        const partQuotes = quotes.filter(quote => quote.kind === "parts");
        if (!partQuotes.length) throw new CommerceStoreError("invalid");
        const availability = await this.checkAvailabilityInternal(approval.selections, buyerId, session);
        if (!availability.available || availability.total.amountMinor !== approval.approvedTotal.amountMinor)
          throw new CommerceStoreError("stale");
        const lines: { merchantId: string; resourceId: string; quantity: number; unitPrice: { amountMinor: number; currency: string } }[] = [];
        for (const quote of partQuotes) for (const line of quote.lines) {
          const reserved = await this.db.collection("merchant_inventory").updateOne({
            merchantId: quote.merchantId, id: line.resourceId, active: true, stock: { $gte: line.quantity },
            "price.currency": "MNT",
          }, { $inc: { stock: -line.quantity } }, { session });
          if (reserved.matchedCount !== 1) throw new CommerceStoreError("unavailable");
          lines.push({ merchantId: quote.merchantId, resourceId: line.resourceId, quantity: line.quantity, unitPrice: line.unitPrice });
          await this.db.collection(inventoryReservations).insertOne({
            contractVersion: "1", id: `ir-${hash(`${parsed.transactionId}:${quote.merchantId}:${line.resourceId}`).slice(0, 40)}`,
            transactionId: parsed.transactionId, approvalId: approval.id, merchantId: quote.merchantId, resourceId: line.resourceId,
            quantity: line.quantity, status: "reserved", createdAt: new Date().toISOString(),
          }, { session });
        }
        const now = new Date().toISOString();
        const ordersByMerchant: ReturnType<typeof partsOrderSchema.parse>[] = [];
        const quotesByMerchant = new Map<string, Quote[]>();
        for (const quote of partQuotes) quotesByMerchant.set(quote.merchantId, [...(quotesByMerchant.get(quote.merchantId) ?? []), quote]);
        for (const [merchantId, merchantQuotes] of quotesByMerchant) {
          const merchantLines = lines.filter(line => line.merchantId === merchantId);
          const order = partsOrderSchema.parse({ contractVersion: "1",
            id: `po-${hash(`${parsed.transactionId}:${merchantId}`).slice(0, 40)}`,
            transactionId: parsed.transactionId, merchantId, buyerId, approvalId: approval.id,
            quoteId: merchantQuotes[0].id, quoteRevision: merchantQuotes[0].revision,
            lines: merchantLines.map(({ resourceId, quantity, unitPrice }) => ({ resourceId, quantity, unitPrice })),
            total: { amountMinor: this.total(merchantQuotes), currency: "MNT" }, status: "reserved", createdAt: now, updatedAt: now });
          await this.db.collection(orders).insertOne({ ...order }, { session });
          ordersByMerchant.push(order);
          await this.db.collection("merchant_transactions").insertOne({
            contractVersion: "1", id: parsed.transactionId, merchantId, buyerId, createdAt: now,
            quoteId: merchantQuotes[0].id, quoteRevision: merchantQuotes[0].revision, approvalId: approval.id,
            idempotencyKey: parsed.idempotencyKey, kind: "parts_order", total: order.total, mode: "simulated",
            paymentMode: "mock", status: "pending", availabilityCheckedAt: availability.checkedAt,
          }, { session });
          await this.audit(session, merchantId, `buyer-${buyerId}`, "transaction_updated", parsed.transactionId, approval.id);
        }
        const transactionUpdate = await this.db.collection(transactions).updateOne({ merchantId: approval.merchantId, id: approval.transactionId,
          approvalId: approval.id, status: "approved" }, { $set: { status: "reserved",
            orderIds: ordersByMerchant.map(order => order.id), progress: "processing", updatedAt: now } }, { session });
        if (transactionUpdate.matchedCount !== 1) throw new CommerceStoreError("conflict");
        return { orders: ordersByMerchant };
      });
    } catch (error) {
      if (duplicateKey(error)) {
        const prior = await this.db.collection(orders).find({ transactionId: parsed.transactionId }).toArray();
        if (prior.length && prior.every(order => order.approvalId === parsed.approvalId))
          return { orders: prior.map(order => partsOrderSchema.parse(domain(order))) };
        throw new CommerceStoreError("conflict");
      }
      throw error;
    }
  }

  private async reserveSlot(session: ClientSession, merchantId: string, slotId: string, transactionId: string,
    capacity: number): Promise<void> {
    const identity = { merchantId, id: slotId };
    await this.db.collection(slotCounters).updateOne(identity, {
      $setOnInsert: { contractVersion: "1", ...identity, count: 0, capacity },
    }, { upsert: true, session });
    const counter = await this.db.collection(slotCounters).findOneAndUpdate({
      ...identity, capacity, count: { $lt: capacity },
    }, { $inc: { count: 1 } }, { session, returnDocument: "after" });
    if (!counter) throw new CommerceStoreError("unavailable");
    await this.db.collection(slotReservations).insertOne({
      contractVersion: "1", id: `sr-${hash(`${transactionId}:${merchantId}:${slotId}`).slice(0, 40)}`,
      transactionId, merchantId, slotId, status: "reserved", createdAt: new Date().toISOString(),
    }, { session });
  }

  async bookRepair(input: { transactionId: string; approvalId: string; idempotencyKey: string }, buyerId: string, merchantIds: string[]) {
    const parsed = z.object({ transactionId: idSchema, approvalId: idSchema, idempotencyKey: idSchema }).strict().parse(input);
    if (parsed.idempotencyKey !== parsed.transactionId) throw new CommerceStoreError("conflict");
    try {
      return await this.transaction(async session => {
        const approval = await this.approvalFor(parsed.approvalId, parsed.transactionId, buyerId, merchantIds, session);
        const prior = await this.db.collection(bookings).findOne({ transactionId: parsed.transactionId }, { session });
        if (prior) {
          if (prior.approvalId !== approval.id) throw new CommerceStoreError("conflict");
          return repairBookingSchema.parse(domain(prior));
        }
        if (!approval.booking) throw new CommerceStoreError("invalid");
        const quotes = await this.selectedQuotes(approval.selections, buyerId, session);
        const repairQuotes = quotes.filter(quote => quote.kind === "repair");
        if (repairQuotes.length !== 1) throw new CommerceStoreError("invalid");
        const quote = repairQuotes[0], bookingTerms = approval.booking;
        if (quote.merchantId !== bookingTerms.merchantId) throw new CommerceStoreError("unauthorized");
        const availability = await this.checkAvailabilityInternal(approval.selections, buyerId, session, parsed.transactionId);
        if (!availability.available || availability.total.amountMinor !== approval.approvedTotal.amountMinor)
          throw new CommerceStoreError("stale");
        const currentWindow = availability.bookingWindows.find(window => window.merchantId === bookingTerms.merchantId);
        if (!currentWindow || currentWindow.startsAt !== bookingTerms.startsAt || currentWindow.endsAt !== bookingTerms.endsAt)
          throw new CommerceStoreError("stale");
        const slot = await this.db.collection("merchant_slots").findOne({
          merchantId: bookingTerms.merchantId, startsAt: bookingTerms.startsAt, endsAt: bookingTerms.endsAt, status: "available",
        }, { session });
        if (!slot) throw new CommerceStoreError("unavailable");
        const services = [];
        for (const line of quote.lines) {
          const doc = await this.db.collection("merchant_services").findOne({
            merchantId: quote.merchantId, id: line.resourceId, active: true,
          }, { session });
          if (!doc) throw new CommerceStoreError("unavailable");
          const service = serviceSchema.parse(domain(doc));
          if (bookingTerms.customerSuppliedParts && service.customerSuppliedParts === "not_accepted")
            throw new CommerceStoreError("invalid");
          services.push(service);
        }
        const duration = services.reduce((sum, service, index) => sum + service.durationMinutes * quote.lines[index].quantity, 0);
        if (Date.parse(bookingTerms.endsAt) - Date.parse(bookingTerms.startsAt) < duration * 60_000)
          throw new CommerceStoreError("unavailable");
        await this.reserveSlot(session, bookingTerms.merchantId, slot.id, parsed.transactionId, slot.capacity);
        const now = new Date().toISOString(), bookingId = `rb-${hash(parsed.transactionId).slice(0, 40)}`;
        const booking = repairBookingSchema.parse({ contractVersion: "1", id: bookingId, transactionId: parsed.transactionId,
          merchantId: quote.merchantId, buyerId, approvalId: approval.id, quoteId: quote.id, quoteRevision: quote.revision,
          serviceIds: quote.lines.map(line => line.resourceId), slotId: slot.id,
          startsAt: bookingTerms.startsAt, endsAt: bookingTerms.endsAt,
          customerSuppliedParts: bookingTerms.customerSuppliedParts, status: "booked", createdAt: now, updatedAt: now });
        await this.db.collection(bookings).insertOne(booking, { session });
        const transaction = await this.db.collection(transactions).findOne({ merchantId: approval.merchantId, id: approval.transactionId }, { session });
        if (!transaction || !["approved", "reserved"].includes(transaction.status)) throw new CommerceStoreError("conflict");
        const transactionUpdate = await this.db.collection(transactions).updateOne({ merchantId: approval.merchantId, id: approval.transactionId,
          status: transaction.status },
          { $set: { status: "booked", bookingIds: [bookingId], progress: "awaiting_payment", updatedAt: now } }, { session });
        if (transactionUpdate.matchedCount !== 1) throw new CommerceStoreError("conflict");
        await this.db.collection("merchant_transactions").updateOne({ id: parsed.transactionId, merchantId: quote.merchantId },
          { $setOnInsert: { contractVersion: "1", id: parsed.transactionId, merchantId: quote.merchantId, buyerId,
            createdAt: now, quoteId: quote.id, quoteRevision: quote.revision, approvalId: approval.id,
            idempotencyKey: parsed.idempotencyKey, kind: "repair_booking", total: quote.total, mode: "simulated",
            paymentMode: "mock", status: "pending" },
            $set: { availabilityCheckedAt: availability.checkedAt } }, { session, upsert: true });
        await this.audit(session, quote.merchantId, `buyer-${buyerId}`, "transaction_updated", parsed.transactionId, approval.id);
        return booking;
      });
    } catch (error) {
      const priorOrder = await this.db.collection(orders).findOne({ transactionId: parsed.transactionId });
      if (priorOrder && priorOrder.status === "reserved") {
        await this.compensateParts(parsed.transactionId, "booking_failed");
      }
      if (duplicateKey(error)) {
        const prior = await this.db.collection(bookings).findOne({ transactionId: parsed.transactionId });
        if (prior && prior.approvalId === parsed.approvalId) return repairBookingSchema.parse(domain(prior));
        throw new CommerceStoreError("conflict");
      }
      throw error;
    }
  }

  private async compensateParts(transactionId: string, reason: string): Promise<void> {
    try {
      await this.transaction(async session => {
        const reservedOrders = await this.db.collection(orders).find({ transactionId, status: "reserved" }, { session }).toArray();
        if (!reservedOrders.length) return true;
        const reservations = await this.db.collection(inventoryReservations).find({ transactionId, status: "reserved" }, { session }).toArray();
        for (const reservation of reservations) {
          const released = await this.db.collection("merchant_inventory").updateOne({
            merchantId: reservation.merchantId, id: reservation.resourceId,
          }, { $inc: { stock: reservation.quantity } }, { session });
          if (released.matchedCount !== 1) throw new Error("Нөөцийн нөхөн олголт бүртгэлгүй байна.");
          const releasedReservation = await this.db.collection(inventoryReservations).updateOne({ merchantId: reservation.merchantId, id: reservation.id, status: "reserved" },
            { $set: { status: "released", releasedAt: new Date().toISOString(), reason } }, { session });
          if (releasedReservation.matchedCount !== 1) throw new Error("Сэлбэгийн нөөцийн төлөвийг нөхөн олгож чадсангүй.");
        }
        await this.db.collection(orders).updateMany({ transactionId, status: "reserved" },
          { $set: { status: "cancelled", updatedAt: new Date().toISOString() } }, { session });
        await this.db.collection(transactions).updateOne({ id: transactionId },
          { $set: { status: reason === "buyer_cancelled" ? "cancelled" : "failed",
            progress: "cancelled", updatedAt: new Date().toISOString() } }, { session });
        const approval = await this.db.collection(approvals).findOne({ transactionId }, { session });
        for (const merchantId of new Set(reservedOrders.map(order => String(order.merchantId)))) {
          await this.db.collection(compensations).insertOne({ contractVersion: "1", id: randomUUID(), transactionId,
            approvalId: approval?.id, merchantId, action: "release_inventory", reason,
            status: "succeeded", createdAt: new Date().toISOString() }, { session });
          if (approval) await this.audit(session, merchantId, "commerce-recovery", "transaction_updated", transactionId, approval.id);
        }
        return true;
      });
    } catch {
      const now = new Date().toISOString();
      await this.db.collection(orders).updateMany({ transactionId, status: "reserved" },
        { $set: { status: "recovery_required", updatedAt: now } });
      await this.db.collection(transactions).updateOne({ id: transactionId },
        { $set: { status: "recovery_required", progress: "processing", recoveryReason: "inventory_compensation_failed", updatedAt: now } });
      const transaction = await this.db.collection(transactions).findOne({ id: transactionId });
      await this.db.collection(compensations).insertOne({ contractVersion: "1", id: randomUUID(), transactionId,
        merchantId: transaction?.merchantId, approvalId: transaction?.approvalId,
        action: "release_inventory", reason, status: "failed", createdAt: now });
      if (transaction) await this.db.collection("merchant_audit_events").insertOne(auditEventSchema.parse({
        contractVersion: "1", id: randomUUID(), merchantId: transaction.merchantId, createdAt: now,
        actorId: "commerce-recovery", actorKind: "system", action: "transaction_updated", entityId: transactionId,
        correlationId: transaction.approvalId, outcome: "failure",
      }));
    }
  }

  private async compensateBooking(transactionId: string, reason: string): Promise<void> {
    try {
      await this.transaction(async session => {
        const booking = await this.db.collection(bookings).findOne({ transactionId, status: "booked" }, { session });
        if (booking) {
          const released = await this.db.collection(slotReservations).updateOne({ transactionId, merchantId: booking.merchantId, status: "reserved" },
            { $set: { status: "released", releasedAt: new Date().toISOString(), reason } }, { session });
          if (released.matchedCount !== 1) throw new Error("Засварын цагийн нөөцийн бүртгэл олдсонгүй.");
          const reservation = await this.db.collection(slotReservations).findOne({ transactionId, merchantId: booking.merchantId }, { session });
          if (!reservation) throw new Error("Засварын цагийн нөөцийн бүртгэл олдсонгүй.");
            const counterUpdate = await this.db.collection(slotCounters).updateOne({ merchantId: booking.merchantId, id: reservation.slotId,
            count: { $gt: 0 } }, { $inc: { count: -1 } }, { session });
            if (counterUpdate.matchedCount !== 1) throw new Error("Засварын цагийн багтаамжийн нөхөн олголт бүртгэлгүй байна.");
            const bookingUpdate = await this.db.collection(bookings).updateOne({ merchantId: booking.merchantId, id: booking.id, status: "booked" },
              { $set: { status: "cancelled", updatedAt: new Date().toISOString() } }, { session });
            if (bookingUpdate.matchedCount !== 1) throw new Error("Засварын захиалгын төлөвийг сэргээж чадсангүй.");
          await this.db.collection(compensations).insertOne({ contractVersion: "1", id: randomUUID(), transactionId,
            approvalId: booking.approvalId, merchantId: booking.merchantId, action: "release_slot",
            reason, status: "succeeded", createdAt: new Date().toISOString() }, { session });
          await this.audit(session, booking.merchantId, "commerce-recovery", "transaction_updated", transactionId, booking.approvalId);
        }
        return true;
      });
    } catch {
      await this.db.collection(bookings).updateOne({ transactionId, status: "booked" },
        { $set: { status: "recovery_required", updatedAt: new Date().toISOString() } });
      await this.db.collection(transactions).updateOne({ id: transactionId },
        { $set: { status: "recovery_required", recoveryReason: "slot_compensation_failed", updatedAt: new Date().toISOString() } });
      const booking = await this.db.collection(bookings).findOne({ transactionId });
      await this.db.collection(compensations).insertOne({ contractVersion: "1", id: randomUUID(), transactionId,
        merchantId: booking?.merchantId, approvalId: booking?.approvalId,
        action: "release_slot", reason, status: "failed", createdAt: new Date().toISOString() });
      if (booking) await this.db.collection("merchant_audit_events").insertOne(auditEventSchema.parse({
        contractVersion: "1", id: randomUUID(), merchantId: booking.merchantId, createdAt: new Date().toISOString(),
        actorId: "commerce-recovery", actorKind: "system", action: "transaction_updated", entityId: transactionId,
        correlationId: booking.approvalId, outcome: "failure",
      }));
    }
  }

  async mockPayment(input: { transactionId: string; approvalId: string; idempotencyKey: string; outcome: "succeeded" | "failed" },
    buyerId: string, merchantIds: string[]) {
    const parsed = z.object({ transactionId: idSchema, approvalId: idSchema, idempotencyKey: idSchema, outcome: z.enum(["succeeded", "failed"]) }).strict().parse(input);
    const payment = await this.transaction(async session => {
        const approval = await this.approvalFor(parsed.approvalId, parsed.transactionId, buyerId, merchantIds, session);
        if (parsed.idempotencyKey !== parsed.transactionId) throw new CommerceStoreError("conflict");
        const existing = await this.db.collection(payments).findOne({ transactionId: parsed.transactionId }, { session });
        if (existing) {
          if (existing.approvalId !== approval.id || existing.outcome !== parsed.outcome) throw new CommerceStoreError("already_paid");
          const { approvalId: _approvalId, idempotencyKey: _idempotencyKey, ...paymentRecord } = domain(existing);
          void _approvalId; void _idempotencyKey;
          return mockPaymentSchema.parse(paymentRecord);
        }
        const transaction = await this.db.collection(transactions).findOne({ merchantId: approval.merchantId,
          id: approval.transactionId, approvalId: approval.id }, { session });
        if (!transaction || !["reserved", "booked"].includes(transaction.status)) throw new CommerceStoreError("conflict");
        const availability = await this.checkAvailabilityInternal(approval.selections, buyerId, session, parsed.transactionId);
        if (!availability.available || availability.total.amountMinor !== approval.approvedTotal.amountMinor)
          throw new CommerceStoreError("stale");
        const now = new Date().toISOString();
        const record = mockPaymentSchema.parse({ contractVersion: "1", id: `mp-${hash(parsed.transactionId).slice(0, 40)}`,
          transactionId: parsed.transactionId, buyerId, amount: approval.approvedTotal, mode: "simulated",
          provider: "mock", outcome: parsed.outcome, createdAt: now });
        await this.db.collection(payments).insertOne({ ...record, approvalId: approval.id, idempotencyKey: parsed.idempotencyKey }, { session });
        const transactionUpdate = await this.db.collection(transactions).updateOne({ merchantId: approval.merchantId, id: approval.transactionId,
          status: transaction.status },
          { $set: { status: parsed.outcome === "succeeded" ? "confirmed" : "payment_failed",
            paymentId: record.id, progress: parsed.outcome === "succeeded" ? "in_progress" : "processing", updatedAt: now } }, { session });
        if (transactionUpdate.matchedCount !== 1) throw new CommerceStoreError("conflict");
        if (parsed.outcome === "succeeded") {
          await this.db.collection(inventoryReservations).updateMany({ transactionId: parsed.transactionId, status: "reserved" },
            { $set: { status: "committed", committedAt: now } }, { session });
        }
        await this.db.collection("merchant_transactions").updateMany({ id: parsed.transactionId }, {
          $set: { status: parsed.outcome === "succeeded" ? "confirmed" : "failed", total: record.amount },
        }, { session });
        await this.audit(session, approval.merchantId, `buyer-${buyerId}`, "transaction_updated", parsed.transactionId, approval.id,
          parsed.outcome === "succeeded" ? "success" : "failure");
        return record;
    });
    if (payment.outcome === "failed") {
      await this.compensateParts(parsed.transactionId, "mock_payment_failed");
      await this.compensateBooking(parsed.transactionId, "mock_payment_failed");
      await this.db.collection(transactions).updateOne({ id: parsed.transactionId, status: "payment_failed" },
        { $set: { status: "failed", progress: "cancelled", updatedAt: new Date().toISOString() } });
    }
    return mockPaymentSchema.parse(payment);
  }

  async cancelPartsOrder(transactionId: string, approvalId: string, buyerId: string, merchantIds: string[]) {
    await this.transaction(async session => {
      const approval = await this.approvalFor(approvalId, transactionId, buyerId, merchantIds, session, true);
      const order = await this.db.collection(orders).findOne({ transactionId, approvalId: approval.id }, { session });
      if (!order) throw new CommerceStoreError("not_found");
      if (order.status === "cancelled") return true;
      if (order.status === "completed") throw new CommerceStoreError("already_paid");
      const transaction = await this.db.collection(transactions).findOne({ id: transactionId, buyerId }, { session });
      if (!transaction) throw new CommerceStoreError("not_found");
      const commerceTransaction = commerceTransactionSchema.parse(domain(transaction));
      if (commerceTransaction.kind !== "parts_order") throw new CommerceStoreError("conflict");
      if (!["approved", "reserved"].includes(commerceTransaction.status)) throw new CommerceStoreError("already_paid");
      const payment = await this.db.collection(payments).findOne({ transactionId, outcome: "succeeded" }, { session });
      if (payment) throw new CommerceStoreError("already_paid");
      const cancelled = await this.db.collection(transactions).updateOne({ id: transactionId, status: transaction.status },
        { $set: { status: "cancelled", progress: "cancelled", updatedAt: new Date().toISOString() } }, { session });
      if (cancelled.matchedCount !== 1) throw new CommerceStoreError("conflict");
    });
    await this.compensateParts(transactionId, "buyer_cancelled");
    const records = await this.db.collection(orders).find({ transactionId }).toArray();
    if (!records.length) throw new CommerceStoreError("not_found");
    if (records.some(order => order.status === "recovery_required")) throw new CommerceStoreError("recovery_required");
    return { orders: records.map(order => partsOrderSchema.parse(domain(order))) };
  }

  async cancelRepairBooking(transactionId: string, approvalId: string, buyerId: string, merchantIds: string[]) {
    const booking = await this.transaction(async session => {
      const approval = await this.approvalFor(approvalId, transactionId, buyerId, merchantIds, session, true);
      const record = await this.db.collection(bookings).findOne({ transactionId, approvalId: approval.id }, { session });
      if (!record) throw new CommerceStoreError("not_found");
      if (record.status === "cancelled") return domain(record);
      if (record.status === "completed") throw new CommerceStoreError("already_paid");
      const transaction = await this.db.collection(transactions).findOne({ id: transactionId, buyerId }, { session });
      if (!transaction) throw new CommerceStoreError("not_found");
      const commerceTransaction = commerceTransactionSchema.parse(domain(transaction));
      if (commerceTransaction.kind !== "repair_booking") throw new CommerceStoreError("conflict");
      if (!["approved", "booked"].includes(commerceTransaction.status)) throw new CommerceStoreError("already_paid");
      const payment = await this.db.collection(payments).findOne({ transactionId, outcome: "succeeded" }, { session });
      if (payment) throw new CommerceStoreError("already_paid");
      const cancelled = await this.db.collection(transactions).updateOne({ id: transactionId, status: transaction.status },
        { $set: { status: "cancelled", progress: "cancelled", updatedAt: new Date().toISOString() } }, { session });
      if (cancelled.matchedCount !== 1) throw new CommerceStoreError("conflict");
      const reservation = await this.db.collection(slotReservations).findOne({ transactionId, merchantId: record.merchantId, status: "reserved" }, { session });
      if (!reservation) throw new CommerceStoreError("recovery_required");
      const released = await this.db.collection(slotReservations).updateOne({ id: reservation.id, status: "reserved" },
        { $set: { status: "released", releasedAt: new Date().toISOString(), reason: "buyer_cancelled" } }, { session });
      if (released.matchedCount !== 1) throw new CommerceStoreError("recovery_required");
      const slotCounter = await this.db.collection(slotCounters).updateOne({ merchantId: record.merchantId,
        id: reservation.slotId, count: { $gt: 0 } }, { $inc: { count: -1 } }, { session });
      if (slotCounter.matchedCount !== 1) throw new CommerceStoreError("recovery_required");
      const now = new Date().toISOString();
      await this.db.collection(bookings).updateOne({ merchantId: record.merchantId, id: record.id, status: "booked" },
        { $set: { status: "cancelled", updatedAt: now } }, { session });
      await this.db.collection(compensations).insertOne({ contractVersion: "1", id: randomUUID(),
        transactionId, approvalId, merchantId: record.merchantId, action: "release_slot",
        reason: "buyer_cancelled", status: "succeeded", createdAt: now }, { session });
      await this.audit(session, record.merchantId, `buyer-${buyerId}`, "transaction_updated", transactionId, approvalId);
      return { ...domain(record), status: "cancelled", updatedAt: now };
    });
    return repairBookingSchema.parse(booking);
  }

  async cancelTransaction(transactionId: string, approvalId: string, buyerId: string, merchantIds: string[]) {
    await this.transaction(async session => {
      const approval = await this.approvalFor(approvalId, transactionId, buyerId, merchantIds, session, true);
      const transaction = await this.db.collection(transactions).findOne({ id: transactionId, buyerId, approvalId: approval.id }, { session });
      if (!transaction) throw new CommerceStoreError("not_found");
      if (transaction.status === "cancelled") return true;
      const payment = await this.db.collection(payments).findOne({ transactionId, outcome: "succeeded" }, { session });
      if (payment || transaction.status === "confirmed") throw new CommerceStoreError("already_paid");
      if (!["approved", "reserved", "booked", "payment_failed", "failed"].includes(transaction.status))
        throw new CommerceStoreError("conflict");
      const cancelled = await this.db.collection(transactions).updateOne({ id: transactionId, status: transaction.status },
        { $set: { status: "cancelled", progress: "cancelled", updatedAt: new Date().toISOString() } }, { session });
      if (cancelled.matchedCount !== 1) throw new CommerceStoreError("conflict");
      await this.audit(session, approval.merchantId, `buyer-${buyerId}`, "transaction_updated", transactionId, approval.id);
    });
    await this.compensateParts(transactionId, "buyer_cancelled");
    await this.compensateBooking(transactionId, "buyer_cancelled");
    const [orderRecords, bookingRecords] = await Promise.all([
      this.db.collection(orders).find({ transactionId }).toArray(),
      this.db.collection(bookings).find({ transactionId }).toArray(),
    ]);
    if ([...orderRecords, ...bookingRecords].some(record => record.status === "recovery_required"))
      throw new CommerceStoreError("recovery_required");
    return this.getTransaction(transactionId, buyerId, merchantIds);
  }

  async getTransaction(transactionId: string, buyerId: string, merchantIds: string[]) {
    idSchema.parse(transactionId);
    const record = await this.db.collection(transactions).findOne({ id: transactionId, buyerId });
    if (!record) throw new CommerceStoreError("not_found");
    const transaction = commerceTransactionSchema.parse(domain(record));
    if (transaction.quoteSelections.some(selection => !merchantIds.includes(selection.merchantId)))
      throw new CommerceStoreError("unauthorized");
    const [orderList, bookingList, payment] = await Promise.all([
      this.db.collection(orders).find({ transactionId }, { projection: { _id: 0 } }).toArray(),
      this.db.collection(bookings).find({ transactionId }, { projection: { _id: 0 } }).toArray(),
      this.db.collection(payments).findOne({ transactionId }, { projection: { _id: 0 } }),
    ]);
    return { transaction, orders: orderList.map(record => partsOrderSchema.parse(domain(record))),
      bookings: bookingList.map(record => repairBookingSchema.parse(domain(record))),
      payment: payment ? (() => {
        const { approvalId: _approvalId, idempotencyKey: _idempotencyKey, ...paymentRecord } = domain(payment);
        void _approvalId; void _idempotencyKey;
        return mockPaymentSchema.parse(paymentRecord);
      })() : null };
  }

  async merchantTransactions(merchantId: string) {
    if (!isMerchant(merchantId)) throw new CommerceStoreError("unauthorized");
    const [orderRecords, bookingRecords, txRecords] = await Promise.all([
      this.db.collection(orders).find({ merchantId })
        .sort({ createdAt: -1 }).limit(100).toArray(),
      this.db.collection(bookings).find({ merchantId }).sort({ createdAt: -1 }).limit(100).toArray(),
      this.db.collection(transactions).find({ quoteSelections: { $elemMatch: { merchantId } } })
        .sort({ createdAt: -1 }).limit(100).toArray(),
    ]);
    const transactionIds = [...new Set([...orderRecords, ...bookingRecords].map(record => String(record.transactionId)))];
    const paymentRecords = transactionIds.length
      ? await this.db.collection(payments).find({ transactionId: { $in: transactionIds } }).toArray()
      : [];
    const paymentByTransaction = new Map(paymentRecords.map(payment => [payment.transactionId, payment]));
    return {
      orders: orderRecords.map(record => {
        return { ...partsOrderSchema.parse(domain(record)),
          payment: paymentByTransaction.get(record.transactionId)?.outcome ?? "pending" };
      }),
      bookings: bookingRecords.map(record => ({ ...repairBookingSchema.parse(domain(record)),
        payment: paymentByTransaction.get(record.transactionId)?.outcome ?? "pending" })),
      transactions: txRecords.map(record => commerceTransactionSchema.parse(domain(record)))
        .filter(transaction => transaction.quoteSelections.some(selection => selection.merchantId === merchantId))
        .map(transaction => ({
          id: transaction.id, kind: transaction.kind, status: transaction.status, progress: transaction.progress,
          updatedAt: transaction.updatedAt, ...(transaction.paymentId ? { paymentId: transaction.paymentId } : {}),
        })),
    };
  }

  async updateMerchantProgress(merchantId: string, entityId: string, kind: "order" | "booking",
    status: "preparing" | "ready" | "completed" | "in_service"): Promise<void> {
    if (!isMerchant(merchantId)) throw new CommerceStoreError("unauthorized");
    idSchema.parse(entityId);
    await this.transaction(async session => {
      const collection = kind === "order" ? orders : bookings;
      const current = await this.db.collection(collection).findOne({ merchantId, id: entityId }, { session });
      if (!current) throw new CommerceStoreError("not_found");
      const payment = await this.db.collection(payments).findOne({ transactionId: current.transactionId, outcome: "succeeded" }, { session });
      if (!payment) throw new CommerceStoreError("conflict");
      const transitions = kind === "order"
        ? { reserved: ["preparing", "ready"], preparing: ["ready"], ready: ["completed"] }
        : { booked: ["in_service"], in_service: ["completed"] };
      const allowed = transitions[current.status as keyof typeof transitions];
      if (!allowed?.includes(status)) throw new CommerceStoreError("conflict");
      const now = new Date().toISOString();
      const updated = await this.db.collection(collection).updateOne({ merchantId, id: entityId, status: current.status },
        { $set: { status, updatedAt: now } }, { session });
      if (updated.matchedCount !== 1) throw new CommerceStoreError("conflict");
      await this.db.collection(transactions).updateOne({ id: current.transactionId },
        { $set: { progress: status === "completed" ? "completed" : "in_progress", updatedAt: now } }, { session });
      await this.audit(session, merchantId, `merchant-${merchantId}`, "transaction_updated", current.transactionId, current.approvalId);
    });
  }
}
