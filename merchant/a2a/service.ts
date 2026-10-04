import "server-only";
import type { Db, MongoClient } from "mongodb";
import { getMerchantClient, getMerchantDb } from "../server/database";
import { DEMO_MERCHANTS } from "../demo-merchants";
import { merchantRFQEnvelopeSchema, type MerchantRFQResponse } from "./contracts";
import { calculateMerchantRFQ } from "./engine";
import { MongoRFQStore, RFQConflictError } from "./store";

export class RFQInputError extends Error {
  constructor(public readonly kind: "invalid_rfq" | "scope_mismatch" | "conflict") {
    super(kind === "invalid_rfq" ? "Үнийн саналын хүсэлтийн мэдээлэл буруу байна." :
      kind === "scope_mismatch" ? "Хүсэлтийн худалдаачин эсвэл худалдан авагчийн эрх зөрж байна." : "Хүсэлтийн дугаар өмнө нь өөр мэдээллээр бүртгэгдсэн байна.");
  }
}
export function createMerchantRFQProcessor(connection: () => Promise<{ client: MongoClient; db: Db }>) {
  return async (merchantId: string, buyerId: string, input: unknown): Promise<MerchantRFQResponse> => {
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
