import "server-only";
import { createHash } from "node:crypto";
import type { Db, Document, MongoClient } from "mongodb";
import { z } from "zod";
import { auditEventSchema, idSchema, rfqSchema, type MerchantProfile } from "../../shared/merchant-contracts";
import { inventorySchema, serviceSchema, slotSchema } from "../private-contracts";
import { publicProfile } from "../server/admin-store";
import { merchantRFQEnvelopeSchema, merchantRFQResponseSchema, type MerchantRFQEnvelope, type MerchantRFQResponse } from "./contracts";

export const RFQ_PROCESSING_COLLECTION = "merchant_rfq_processing";
export type MerchantRFQData = {
  profile: MerchantProfile | null;
  inventory: z.infer<typeof inventorySchema>[];
  services: z.infer<typeof serviceSchema>[];
  slots: z.infer<typeof slotSchema>[];
};
export class RFQConflictError extends Error {
  constructor() {
    super("Энэ хүсэлтийн дугаар өмнө нь өөр мэдээллээр бүртгэгдсэн байна.");
    this.name = "RFQConflictError";
  }
}

// Canonicalize parsed domain data, so object property order is not an idempotency boundary.
function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJSON(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJSON(value)).digest("hex");
}
function privateRecord(document: Document): Document {
  const { _id, _version, ...record } = document;
  void _id; void _version;
  return record;
}
function failedResponse(merchantId: string, envelope: MerchantRFQEnvelope): MerchantRFQResponse {
  return merchantRFQResponseSchema.parse({ contractVersion: "1", merchantId,
    rfqId: envelope.rfq.id, correlationId: envelope.correlationId, outcome: "failed",
    message: "Хүсэлтийг боловсруулахад алдаа гарлаа. Худалдаачинтай холбогдоно уу.",
    issues: [{ code: "processing_error", message: "Хүсэлтийг боловсруулах боломжгүй байна." }],
  });
}
function verifyResponse(response: MerchantRFQResponse, merchantId: string, buyerId: string, envelope: MerchantRFQEnvelope): void {
  if (response.merchantId !== merchantId || response.rfqId !== envelope.rfq.id || response.correlationId !== envelope.correlationId)
    throw new RFQConflictError();
  const quote = response.quote;
  if (quote && (quote.merchantId !== merchantId || quote.buyerId !== buyerId || quote.rfqId !== envelope.rfq.id || quote.kind !== envelope.rfq.kind))
    throw new RFQConflictError();
}
function cachedResponse(document: Document, requestHash: string, merchantId: string, buyerId: string, envelope: MerchantRFQEnvelope): MerchantRFQResponse {
  if (document.merchantId !== merchantId || document.id !== envelope.rfq.id || document.buyerId !== buyerId || document.requestHash !== requestHash)
    throw new RFQConflictError();
  const parsed = merchantRFQResponseSchema.safeParse(document.response);
  if (!parsed.success) throw new RFQConflictError();
  verifyResponse(parsed.data, merchantId, buyerId, envelope);
  return parsed.data;
}
function duplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === 11000);
}

// merchantId and buyerId must come from the authenticated A2A context. Payload values never authorize access.
export class MongoRFQStore {
  constructor(private readonly client: MongoClient, private readonly db: Db) {}

  async processOnce(merchantId: string, buyerId: string, input: MerchantRFQEnvelope,
    compute: (data: MerchantRFQData, now: Date) => MerchantRFQResponse): Promise<MerchantRFQResponse> {
    idSchema.parse(merchantId); idSchema.parse(buyerId);
    const envelope = merchantRFQEnvelopeSchema.parse(input);
    if (envelope.rfq.merchantId !== merchantId || envelope.rfq.buyerId !== buyerId) throw new RFQConflictError();
    const requestHash = hash(envelope);
    const identity = { merchantId, id: envelope.rfq.id };
    const session = this.client.startSession();
    try {
      // The entire result is committed atomically. No inventory or slot document is mutated.
      const result = await session.withTransaction(async () => {
        const cached = await this.db.collection(RFQ_PROCESSING_COLLECTION).findOne(identity, { session });
        if (cached) return cachedResponse(cached, requestHash, merchantId, buyerId, envelope);
        if (await this.db.collection("merchant_rfqs").findOne(identity, { session }) ||
            await this.db.collection("merchant_quotes").findOne({ merchantId, rfqId: envelope.rfq.id }, { session }))
          throw new RFQConflictError();

        const profileDocument = await this.db.collection("merchant_profiles").findOne({ merchantId, id: merchantId }, { session });
        // Driver operations within a transaction are sequential, as required by MongoDB's session API.
        const inventoryDocuments = await this.db.collection("merchant_inventory").find({ merchantId }, { session }).toArray();
        const serviceDocuments = await this.db.collection("merchant_services").find({ merchantId }, { session }).toArray();
        const slotDocuments = await this.db.collection("merchant_slots").find({ merchantId }, { session }).toArray();
        const now = new Date();
        const completedAt = now.toISOString();
        let response: MerchantRFQResponse;
        try {
          const data: MerchantRFQData = {
            profile: profileDocument ? publicProfile(profileDocument) : null,
            inventory: inventoryDocuments.map(d => inventorySchema.parse(privateRecord(d))),
            services: serviceDocuments.map(d => serviceSchema.parse(privateRecord(d))),
            slots: slotDocuments.map(d => slotSchema.parse(privateRecord(d))),
          };
          if ((data.profile && data.profile.merchantId !== merchantId) ||
              [...data.inventory, ...data.services, ...data.slots].some(d => d.merchantId !== merchantId))
            throw new RFQConflictError();
          response = merchantRFQResponseSchema.parse(compute(data, now));
          verifyResponse(response, merchantId, buyerId, envelope);
          if (response.quote) {
            const resources = envelope.rfq.kind === "parts" ? data.inventory : data.services;
            if (response.quote.lines.some(line => !resources.some(resource => resource.id === line.resourceId && resource.merchantId === merchantId)))
              throw new RFQConflictError();
          }
        } catch {
          // Never serialize validation failures or callback exceptions: they may contain private data.
          response = failedResponse(merchantId, envelope);
        }
        const status = response.outcome === "quoted" || response.outcome === "partial" ? "quoted" :
          response.outcome === "expired" ? "expired" : "declined";
        const rfq = rfqSchema.parse({ ...envelope.rfq, status });
        const audit = (action: "rfq_received" | "quote_created" | "rfq_processed" | "rfq_failed", entityId: string, outcome: "success" | "failure") =>
          auditEventSchema.parse({ contractVersion: "1", id: `a2a-${hash([merchantId, envelope.rfq.id, action]).slice(0, 48)}`,
            merchantId, createdAt: completedAt, actorId: buyerId, actorKind: "buyer", action,
            entityId, correlationId: envelope.correlationId, outcome });
        // insertOne may add _id to its argument. Clone every write document so driver
        // metadata cannot mutate the public response or its cached domain payload.
        await this.db.collection("merchant_rfqs").insertOne(structuredClone(rfq), { session });
        await this.db.collection("merchant_audit_events").insertOne(structuredClone(audit("rfq_received", rfq.id, "success")), { session });
        if (response.quote) {
          await this.db.collection("merchant_quotes").insertOne(structuredClone(response.quote), { session });
          await this.db.collection("merchant_audit_events").insertOne(structuredClone(audit("quote_created", response.quote.id, "success")), { session });
        }
        await this.db.collection("merchant_audit_events").insertOne(
          structuredClone(audit(response.outcome === "failed" ? "rfq_failed" : "rfq_processed", rfq.id, response.outcome === "failed" ? "failure" : "success")), { session });
        await this.db.collection(RFQ_PROCESSING_COLLECTION).insertOne(structuredClone({ contractVersion: "1", ...identity, buyerId,
          requestHash, envelope, correlationId: envelope.correlationId, status: response.outcome,
          response, quoteRevision: response.quote?.revision ?? null, createdAt: completedAt, completedAt,
        }), { session });
        // Durable notification intent is committed with the RFQ. No Telegram call runs in a database transaction.
        if (!["expired", "failed"].includes(response.outcome) && dataNotificationEligible(profileDocument, envelope)) {
          await this.db.collection("merchant_telegram_notifications").insertOne(structuredClone({
            contractVersion: "1", merchantId, id: `n-${hash([merchantId, rfq.id]).slice(0, 40)}`,
            rfqId: rfq.id, correlationId: envelope.correlationId, envelope, createdAt: completedAt,
            status: "pending", nextAttemptAt: now, attempts: 0,
          }), { session });
        }
        return response;
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      if (!result) throw new Error("Хүсэлтийн үр дүнг хадгалах боломжгүй байна.");
      return result;
    } catch (error) {
      if (duplicateKey(error)) {
        // An identical concurrent request may have committed first. Return only its validated scoped result.
        const committed = await this.db.collection(RFQ_PROCESSING_COLLECTION).findOne(identity);
        if (committed) return cachedResponse(committed, requestHash, merchantId, buyerId, envelope);
        throw new RFQConflictError();
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }
}

function dataNotificationEligible(profile: Document | null, envelope: MerchantRFQEnvelope): boolean {
  return Boolean(profile?.active && profile.merchantId === envelope.rfq.merchantId && profile.kind === envelope.rfq.kind);
}
