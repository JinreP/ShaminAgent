import 'server-only';
import { z } from "zod";
import type { Db, MongoClient } from "mongodb";
import { idSchema, merchantProfileSchema, rfqSchema, quoteSchema, negotiationSchema,
  approvalSchema, transactionSchema, auditEventSchema, type AuditEvent } from "../../shared/merchant-contracts";

export const recordSchemas = { merchant_profiles: merchantProfileSchema, merchant_rfqs: rfqSchema,
  merchant_quotes: quoteSchema, merchant_negotiations: negotiationSchema,
  merchant_approvals: approvalSchema, merchant_transactions: transactionSchema };
export type RecordCollection = keyof typeof recordSchemas;
export type RecordFor<K extends RecordCollection> = z.infer<(typeof recordSchemas)[K]>;

export function assertMerchantScope(merchantId: string, record: { merchantId: string }): void {
  idSchema.parse(merchantId);
  if (record.merchantId !== merchantId) throw new Error("Merchant scope mismatch");
}
const actions = { merchant_profiles: "profile_saved", merchant_rfqs: "rfq_received",
  merchant_quotes: "quote_created", merchant_negotiations: "negotiation_recorded",
  merchant_approvals: "approval_verified", merchant_transactions: "transaction_created" } as const;
// Scope must come from authenticated server context, never directly from an HTTP body.
export class MerchantRepository {
  constructor(private readonly client: MongoClient, private readonly db: Db, private readonly merchantId: string) {
    idSchema.parse(merchantId);
  }
  async findById<K extends RecordCollection>(collection: K, id: string): Promise<RecordFor<K> | null> {
    idSchema.parse(id);
    const document = await this.db.collection(collection).findOne({ merchantId: this.merchantId, id }, { projection: { _id: 0 } });
    return document ? recordSchemas[collection].parse(document) as RecordFor<K> : null;
  }
  // Foundation persistence only. Approval verification and transaction execution belong to later phases.
  async insertAudited<K extends Exclude<RecordCollection, "merchant_approvals" | "merchant_transactions">>(
    collection: K, input: RecordFor<K>, auditInput: AuditEvent,
  ): Promise<void> {
    if (!["merchant_profiles", "merchant_rfqs", "merchant_quotes", "merchant_negotiations"].includes(collection))
      throw new Error("Approval and transaction writes require future verified services");
    const record = recordSchemas[collection].parse(input);
    const audit = auditEventSchema.parse(auditInput);
    assertMerchantScope(this.merchantId, record);
    assertMerchantScope(this.merchantId, audit);
    if (audit.entityId !== record.id || audit.action !== actions[collection] || audit.outcome !== "success")
      throw new Error("Audit event must describe the persisted record");
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        await this.db.collection(collection).insertOne({ ...record }, { session });
        await this.db.collection("merchant_audit_events").insertOne({ ...audit }, { session });
      });
    } finally { await session.endSession(); }
  }
}
