import "server-only";
import type { Db, MongoClient } from "mongodb";
import { getMerchantClient, getMerchantDb } from "../server/database";
import { DEMO_MERCHANTS } from "../demo-merchants";
import { merchantRFQEnvelopeSchema, type MerchantA2AResponse } from "./contracts";
import { quoteUpdatesRequestSchema } from "../telegram/contracts";
import { TelegramMerchantStore, TelegramStoreError } from "../telegram/store";
import { calculateMerchantRFQ } from "./engine";
import { MongoRFQStore, RFQConflictError } from "./store";
import { negotiateQuoteRequestSchema, getNegotiationResultRequestSchema } from "../negotiation/contracts";
import { NegotiationStore, NegotiationStoreError } from "../negotiation/store";

export class RFQInputError extends Error {
  constructor(public readonly kind: "invalid_rfq" | "scope_mismatch" | "conflict") {
    super(kind === "invalid_rfq" ? "Үнийн саналын хүсэлтийн мэдээлэл буруу байна." :
      kind === "scope_mismatch" ? "Хүсэлтийн худалдаачин эсвэл худалдан авагчийн эрх зөрж байна." : "Хүсэлтийн дугаар өмнө нь өөр мэдээллээр бүртгэгдсэн байна.");
  }
}
export function createMerchantRFQProcessor(connection: () => Promise<{ client: MongoClient; db: Db }>) {
  return async (merchantId: string, buyerId: string, input: unknown): Promise<MerchantA2AResponse> => {
    if (input && typeof input === "object" && "action" in input &&
        (input.action === "negotiate_quote" || input.action === "get_negotiation_result")) {
      const request = input.action === "negotiate_quote" ? negotiateQuoteRequestSchema.safeParse(input) : getNegotiationResultRequestSchema.safeParse(input);
      if (!request.success) throw new RFQInputError("invalid_rfq");
      if (!DEMO_MERCHANTS.some(merchant => merchant.id === merchantId)) throw new RFQInputError("scope_mismatch");
      if (request.data.action === "negotiate_quote" && (request.data.negotiation.merchantId !== merchantId ||
          request.data.negotiation.buyerId !== buyerId)) throw new RFQInputError("scope_mismatch");
      if (request.data.action === "negotiate_quote" && Date.parse(request.data.negotiation.createdAt) > Date.now() + 60000)
        throw new RFQInputError("invalid_rfq");
      try {
        const { client, db } = await connection(), store = new NegotiationStore(client, db);
        return request.data.action === "negotiate_quote" ? await store.submit(merchantId, buyerId, request.data) :
          await store.getResult(merchantId, buyerId, request.data.rfqId, request.data.negotiationId);
      } catch (error) {
        if (error instanceof NegotiationStoreError) throw new RFQInputError(error.code === "conflict" ? "conflict" : "scope_mismatch");
        throw new Error("Үнийн хэлэлцээний үр дүнг боловсруулах боломжгүй байна.");
      }
    }
    if (input && typeof input === "object" && "action" in input && input.action === "get_quote_updates") {
      const request = quoteUpdatesRequestSchema.safeParse(input);
      if (!request.success) throw new RFQInputError("invalid_rfq");
      try {
        const { client, db } = await connection();
        return await new TelegramMerchantStore(client, db).getQuoteUpdates(merchantId, buyerId, request.data.rfqId, request.data.afterRevision);
      } catch (error) {
        if (error instanceof TelegramStoreError) throw new RFQInputError("scope_mismatch");
        throw new Error("Үнийн саналын шинэчлэлтийг авах боломжгүй байна.");
      }
    }
    const parsed = merchantRFQEnvelopeSchema.safeParse(input);
    if (!parsed.success || parsed.data.rfq.items.length > 100 || Date.parse(parsed.data.rfq.createdAt) > Date.now() + 60000)
      throw new RFQInputError("invalid_rfq");
    const envelope = parsed.data;
    if (!DEMO_MERCHANTS.some(m => m.id === merchantId) || envelope.rfq.merchantId !== merchantId || envelope.rfq.buyerId !== buyerId)
      throw new RFQInputError("scope_mismatch");
    try {
      const { client, db } = await connection();
      return await new MongoRFQStore(client, db).processOnce(merchantId, buyerId, envelope,
        (data, now) => calculateMerchantRFQ(merchantId, envelope, data, now));
    } catch (error) {
      if (error instanceof RFQConflictError) throw new RFQInputError("conflict");
      // A quote is never returned unless its RFQ, quote and audit transaction committed.
      // Connectivity failures cannot themselves be persisted; retry the same RFQ after recovery.
      return { contractVersion: "1", merchantId, rfqId: envelope.rfq.id, correlationId: envelope.correlationId,
        outcome: "failed", message: "Хүсэлтийн үр дүнг өгөгдлийн санд хадгалж чадсангүй. Түр хүлээгээд дахин оролдоно уу.",
        issues: [{ code: "processing_error", message: "Хүсэлтийг боловсруулах боломжгүй байна." }] };
    }
  };
}
export const processMerchantRFQ = createMerchantRFQProcessor(async () => ({ client: await getMerchantClient(), db: await getMerchantDb() }));
