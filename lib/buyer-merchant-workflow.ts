import "server-only";
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { z } from "zod";
import { buyerReceiptSchema, buyerCheckoutSchema, type BuyerReceipt } from "./buyer-types";
import { bundleOffer, toMinor, type BuyerGoal, type BuyerOffer } from "./buyer-merchant-domain";
import type { BuyerMerchantGateway } from "./buyer-merchant-client";
import { negotiateQuoteRequestSchema, type NegotiationRequest, type NegotiationResponse } from "../merchant/negotiation/contracts";
import { availabilityResultSchema, commerceTransactionSchema, partsOrderSchema, repairBookingSchema, mockPaymentSchema } from "../merchant/commerce/contracts";

export class BuyerWorkflowError extends Error {}
type Checkout = z.infer<typeof buyerCheckoutSchema>;
type PendingNegotiation = { token: string; target: number; inputs: NegotiationRequest[]; results: (NegotiationResponse | null)[] };
type RequestDocument = {
  _id: string; ownerId: string; status: "draft" | "quoted" | "completed"; version: number;
  goal?: BuyerGoal; quotes: BuyerOffer[]; selectedQuote?: BuyerOffer;
  checkout?: Checkout; pendingNegotiation?: PendingNegotiation;
  receipt?: BuyerReceipt; receiptToken?: string; updatedAt: Date;
  operationId?: string; operationUntil?: Date;
};
const approvalCreatedSchema = z.object({ approvalId: z.string(), transactionId: z.string(), approvalUrl: z.string().url(), expiresAt: z.string(), total: z.number() });
export const merchantTransactionResultSchema = z.object({
  transaction: commerceTransactionSchema, orders: z.array(partsOrderSchema), bookings: z.array(repairBookingSchema),
  payment: mockPaymentSchema.nullable(),
});

export class BuyerMerchantWorkflow {
  constructor(private db: Db, private ownerId: string, private gateway: BuyerMerchantGateway) {}

  private async withRequest<T>(id: string, work: (document: RequestDocument,
    save: (fields: Partial<RequestDocument>, unset?: string[]) => Promise<void>) => Promise<T>): Promise<T> {
    const requests = this.db.collection<RequestDocument>("repairRequests");
    const operationId = randomUUID(), now = new Date();
    const document = await requests.findOneAndUpdate({ _id: id, ownerId: this.ownerId,
      $or: [{ operationUntil: { $exists: false } }, { operationUntil: { $lte: now } }] },
    { $set: { operationId, operationUntil: new Date(now.getTime() + 5 * 60_000) } }, { returnDocument: "after" });
    if (!document) throw new BuyerWorkflowError("Хүсэлт олдсонгүй эсвэл өөр үйлдэл боловсруулж байна. Түр хүлээгээд дахин оролдоорой.");
    const save = async (fields: Partial<RequestDocument>, unset: string[] = []) => {
      const result = await requests.updateOne({ _id: id, ownerId: this.ownerId, operationId }, {
        $set: { ...fields, updatedAt: new Date() }, $inc: { version: 1 },
        ...(unset.length ? { $unset: Object.fromEntries(unset.map(key => [key, ""])) } : {}),
      });
      if (result.matchedCount !== 1) throw new BuyerWorkflowError("Хүсэлтийн үйлдлийн хугацаа дууссан. Хадгалсан хүсэлтээ дахин нээгээрэй.");
    };
    try { return await work(document, save); }
    finally { await requests.updateOne({ _id: id, ownerId: this.ownerId, operationId }, { $unset: { operationId: "", operationUntil: "" } }); }
  }

  async quotes(requestId: string, goal: BuyerGoal) {
    return this.withRequest(requestId, async (current, save) => {
      if (current.status === "completed" || current.checkout || current.pendingNegotiation) {
        throw new BuyerWorkflowError("Өмнөх хэлэлцээ эсвэл захиалгаа дуусгах, эсвэл шинэ хүсэлт үүсгэх шаардлагатай.");
      }
      const result = await this.gateway.quoteBatch(goal, randomUUID());
      await save({ goal, quotes: result.quotes, status: "quoted" }, ["selectedQuote", "approval"]);
      return { requestId, ...result, mode: "demo", source: "merchant" };
    });
  }

  async negotiate(requestId: string, token: string, target: number) {
    return this.withRequest(requestId, async (current, save) => {
      const quote = current.quotes.find(item => item.token === token);
      if (current.status !== "quoted" || !quote?.merchant || current.checkout) throw new BuyerWorkflowError("Merchant санал олдсонгүй. Дахин санал аваарай.");
      if (quote.merchant.parts.quote.buyerId !== this.gateway.buyerId) throw new BuyerWorkflowError("Buyer identity тохирохгүй байна.");
      if (!Number.isSafeInteger(target) || target <= 0 || target >= quote.total) throw new BuyerWorkflowError("Зорилтот үнэ бүхэл төгрөгөөр, одоогийн үнээс бага байна.");
      let pending = current.pendingNegotiation;
      if (pending && (pending.token !== token || pending.target !== target)) throw new BuyerWorkflowError("Өмнөх хэлэлцээний хариуг эхлээд шалгана уу.");
      if (!pending) {
        if (quote.revision !== 1 || quote.expiresAt <= Date.now()) throw new BuyerWorkflowError("Санал хуучирсан эсвэл хэлэлцээ хийгдсэн байна. Дахин санал аваарай.");
        const partsTarget = Math.max(1, Math.floor(target * quote.parts / quote.total));
        const repairTarget = target - partsTarget;
        if (repairTarget < 1) throw new BuyerWorkflowError("Багцын хоёр үнийн зорилт эерэг байх ёстой.");
        const now = new Date().toISOString();
        const inputs = [quote.merchant.parts, quote.merchant.repair].map((offer, index) => negotiateQuoteRequestSchema.parse({
          contractVersion: "1", action: "negotiate_quote", rfqId: offer.quote.rfqId, correlationId: offer.correlationId,
          expiresAt: new Date(quote.expiresAt).toISOString(), negotiation: {
            contractVersion: "1", id: `neg-${randomUUID()}`, merchantId: offer.quote.merchantId, buyerId: this.gateway.buyerId,
            createdAt: now, quoteId: offer.quote.id, quoteRevision: offer.quote.revision,
            requestedTotal: { amountMinor: toMinor(index === 0 ? partsTarget : repairTarget), currency: "MNT" }, status: "requested",
          },
        }));
        pending = { token, target, inputs, results: [null, null] };
        // IDs are persisted before protocol calls so retries cannot create new rounds.
        await save({ pendingNegotiation: pending, selectedQuote: quote });
      }
      for (const [index, input] of pending.inputs.entries()) {
        const prior = pending.results[index];
        if (prior && prior.outcome !== "pending") continue;
        pending.results[index] = prior ? await this.gateway.negotiationResult(input) : await this.gateway.negotiate(input);
        await save({ pendingNegotiation: pending });
      }
      if (pending.results.some(result => result?.outcome === "pending")) {
        return { requestId, quote, pending: true, message: "Merchant хүнээс шийдвэр хүлээж байна. Дараа нь хариуг шалгаарай." };
      }
      const partsResult = pending.results[0]!, repairResult = pending.results[1]!;
      const bundle = { ...quote.merchant,
        parts: { ...quote.merchant.parts, quote: partsResult.quote ?? quote.merchant.parts.quote },
        repair: { ...quote.merchant.repair, quote: repairResult.quote ?? quote.merchant.repair.quote },
        booking: { ...quote.merchant.booking, ...(repairResult.serviceWindow ?? {}) },
      };
      const names = { [bundle.parts.quote.merchantId]: quote.partsMerchant, [bundle.repair.quote.merchantId]: quote.repairMerchant };
      const next = bundleOffer(quote.goal, bundle, names, quote.revision + 1);
      // Other combinations may reference a superseded merchant revision.
      const previousIds = new Set(pending.results.filter(result => result?.quote).map(result => result!.negotiation.quoteId));
      const quotes = current.quotes.filter(item => item.token !== token).map(item =>
        item.merchant && [item.merchant.parts.quote.id, item.merchant.repair.quote.id].some(id => previousIds.has(id))
          ? { ...item, expiresAt: 0 } : item);
      quotes.push(next);
      await save({ quotes, selectedQuote: next }, ["pendingNegotiation", "approval"]);
      return { requestId, quote: next, pending: false, message: `${partsResult.message}\n${repairResult.message}` };
    });
  }

  async confirm(requestId: string, token: string, approvedTotal: number) {
    return this.withRequest(requestId, async (current, save) => {
      if (current.status === "completed") {
        if (current.receiptToken === token && current.receipt?.quote.total === approvedTotal) return { requestId, receipt: current.receipt };
        throw new BuyerWorkflowError("Энэ хүсэлт өөр саналаар батлагдсан байна.");
      }
      const quote = current.quotes.find(item => item.token === token);
      if (current.status !== "quoted" || !quote?.merchant || current.pendingNegotiation || quote.total !== approvedTotal) {
        throw new BuyerWorkflowError("Батлах Merchant санал олдсонгүй эсвэл хэлэлцээ дуусаагүй байна.");
      }
      if (quote.merchant.parts.quote.buyerId !== this.gateway.buyerId) throw new BuyerWorkflowError("Buyer identity тохирохгүй байна.");
      let checkout = current.checkout;
      if (checkout && (checkout.quoteToken !== token || checkout.approvedTotal !== approvedTotal)) {
        throw new BuyerWorkflowError("Өмнөх зөвшөөрлийн багцыг өөрчилж болохгүй. Шинэ хүсэлт үүсгээрэй.");
      }
      return this.gateway.commerce(async call => {
        if (!checkout) {
          if (quote.expiresAt <= Date.now()) throw new BuyerWorkflowError("Саналын хугацаа дууссан. Дахин санал аваарай.");
          const selections = [quote.merchant!.parts.quote, quote.merchant!.repair.quote].map(item => ({
            merchantId: item.merchantId, quoteId: item.id, quoteRevision: item.revision,
          }));
          const available = await call("check_availability", { selections }, availabilityResultSchema);
          if (!available.available || available.total.currency !== "MNT" || available.total.amountMinor !== toMinor(approvedTotal) ||
              !available.bookingWindows.some(window => window.merchantId === quote.merchant!.booking.merchantId &&
                window.startsAt === quote.merchant!.booking.startsAt && window.endsAt === quote.merchant!.booking.endsAt)) {
            throw new BuyerWorkflowError("Merchant үнэ, үлдэгдэл эсвэл засварын цаг өөрчлөгдсөн. Дахин санал аваарай.");
          }
          checkout = { transactionId: `txn-${randomUUID()}`, quoteToken: token, approvedTotal,
            expiresAt: new Date(Math.min(quote.expiresAt, Date.now() + 10 * 60_000)).toISOString() };
          await save({ checkout, selectedQuote: quote });
          const approval = await call("request_user_approval", {
            transactionId: checkout.transactionId, selections,
            approvedTotal: { amountMinor: toMinor(approvedTotal), currency: "MNT" },
            booking: quote.merchant!.booking, expiresAt: checkout.expiresAt,
          }, approvalCreatedSchema);
          const url = new URL(approval.approvalUrl);
          if (approval.transactionId !== checkout.transactionId || approval.total !== toMinor(approvedTotal) ||
              url.origin !== this.gateway.origin || !/^\/merchant\/approval\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.search || url.hash) {
            throw new BuyerWorkflowError("Merchant зөвшөөрлийн хариулт тохирохгүй байна.");
          }
          checkout = { ...checkout, approvalId: approval.approvalId, approvalUrl: approval.approvalUrl, expiresAt: approval.expiresAt };
          await save({ checkout });
          return { requestId, checkout, message: "Зөвшөөрлийн холбоосыг нээж батлаад, захиалгаа үргэлжлүүлээрэй." };
        }
        // Never retry request_user_approval blindly: that merchant tool is not
        // replayable. Keep the same persisted transaction after uncertain I/O.
        let result = await call("get_transaction_status", { transactionId: checkout.transactionId }, merchantTransactionResultSchema);
        const validateTransaction = () => {
          if (result.transaction.id !== checkout!.transactionId || result.transaction.buyerId !== this.gateway.buyerId ||
              result.transaction.total.currency !== "MNT" || result.transaction.total.amountMinor !== toMinor(approvedTotal) ||
              (checkout!.approvalId && result.transaction.approvalId !== checkout!.approvalId)) {
            throw new BuyerWorkflowError("Merchant гүйлгээний хүрээ тохирохгүй байна.");
          }
        };
        validateTransaction();
        if (result.transaction.status === "approval_pending") {
          if (!checkout.approvalUrl) throw new BuyerWorkflowError("Зөвшөөрлийн холбоос хадгалагдахаас өмнө холболт тасарсан. Шинэ хүсэлт үүсгээрэй; өмнөхийг автоматаар дахин захиалахгүй.");
          if (Date.parse(checkout.expiresAt) <= Date.now()) throw new BuyerWorkflowError("Зөвшөөрлийн хугацаа дууссан. Шинэ хүсэлт үүсгээрэй.");
          return { requestId, checkout, message: "Merchant хуудсан дээр Зөвшөөрөх товчийг дарна уу." };
        }
        if (["cancelled", "failed", "payment_failed", "recovery_required"].includes(result.transaction.status)) {
          throw new BuyerWorkflowError(`Merchant гүйлгээ: ${result.transaction.status}. Merchant dashboard-аас төлөвийг шалгана уу.`);
        }
        if (!checkout.approvalId) {
          checkout = { ...checkout, approvalId: result.transaction.approvalId };
          await save({ checkout });
        }
        const input = { transactionId: checkout.transactionId, approvalId: checkout.approvalId, idempotencyKey: checkout.transactionId };
        if (result.transaction.status !== "confirmed") {
          // The status controls resumable steps; retries keep the same IDs.
          if (result.transaction.status === "approved") {
            await call("create_parts_order", input, z.object({ orders: z.array(partsOrderSchema).min(1) }));
          }
          if (["approved", "reserved"].includes(result.transaction.status)) {
            await call("book_repair", input, repairBookingSchema);
          }
          await call("mock_payment", { ...input, outcome: "succeeded" }, mockPaymentSchema);
          result = await call("get_transaction_status", { transactionId: checkout.transactionId }, merchantTransactionResultSchema);
          validateTransaction();
        }
        if (result.transaction.status !== "confirmed" || result.payment?.outcome !== "succeeded" ||
            result.payment.amount.amountMinor !== toMinor(approvedTotal) || !result.orders.length || !result.bookings.length) {
          throw new BuyerWorkflowError("Merchant захиалга бүрэн батлагдаагүй байна. Дахин төлөв шалгаарай.");
        }
        const receipt = buyerReceiptSchema.parse({
          id: requestId.toUpperCase(), transactionId: checkout.transactionId,
          orderId: result.orders.map(order => order.id).join(", "), bookingId: result.bookings.map(booking => booking.id).join(", "),
          paymentId: result.payment.id, quote, source: "merchant", mode: "demo", status: "demo_completed",
        });
        await save({ status: "completed", receipt, receiptToken: token, selectedQuote: quote });
        return { requestId, receipt };
      });
    });
  }
}
