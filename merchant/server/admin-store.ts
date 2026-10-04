import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db, MongoClient, Document } from "mongodb";
import { merchantProfileSchema, auditEventSchema, rfqSchema, quoteSchema, transactionSchema, type MerchantProfile } from "../../shared/merchant-contracts";
import { adminSchemas, type AdminResource, type AdminRecord, type Versioned, type DashboardSnapshot } from "../private-contracts";
import { assertMerchantScope } from "./repository";
import { assertDemoMerchant, MerchantAccessError } from "./demo-auth";

export const adminCollections = { profile: "merchant_profiles", inventory: "merchant_inventory",
  service: "merchant_services", slot: "merchant_slots", settings: "merchant_settings" } as const;
const auditActions = { profile: "profile_saved", inventory: "inventory_saved", service: "service_saved", slot: "slot_saved", settings: "settings_saved" } as const;
export class EditConflictError extends Error { constructor() { super("This record changed. Reload it before saving again."); } }
function versioned<K extends AdminResource>(resource: K, document: Document): Versioned<K> {
  const { _id, _version, ...record } = document;
  void _id;
  return { record: adminSchemas[resource].parse(record) as AdminRecord<K>, version: z.number().int().positive().parse(_version ?? 1) };
}
export function publicProfile(document: Document): MerchantProfile {
  // Explicit allowlist: even corrupted profile documents cannot publish private data.
  const { contractVersion, id, merchantId, createdAt, name, kind, mode, capabilities, location, active } = document;
  return merchantProfileSchema.parse({ contractVersion, id, merchantId, createdAt, name, kind, mode, capabilities, location, active });
}
export async function discoverMerchants(db: Db, kind?: "parts" | "repair", capability?: string) {
  const profiles = await db.collection("merchant_profiles").find({ active: true, ...(kind ? { kind } : {}) }, {
    projection: { _id: 0, contractVersion: 1, id: 1, merchantId: 1, createdAt: 1, name: 1, kind: 1, mode: 1, capabilities: 1, location: 1, active: 1 },
  }).sort({ id: 1 }).limit(100).toArray();
  return profiles.map(publicProfile).filter(p => !capability || p.capabilities.some(c => c.toLowerCase().includes(capability.toLowerCase())));
}
// Only constructed after a verified demo session. Production must use a separate auth adapter.
export class MerchantAdminStore {
  constructor(private readonly client: MongoClient, private readonly db: Db, private readonly merchantId: string) { assertDemoMerchant(merchantId); }
  async list<K extends AdminResource>(resource: K): Promise<Versioned<K>[]> {
    const documents = await this.db.collection(adminCollections[resource]).find({ merchantId: this.merchantId }).sort({ id: 1 }).limit(200).toArray();
    return documents.map(d => versioned(resource, d));
  }
  async snapshot(): Promise<DashboardSnapshot> {
    const [profiles, inventory, services, slots, settings, rfqs, quotes, transactions] = await Promise.all([
      this.list("profile"), this.list("inventory"), this.list("service"), this.list("slot"), this.list("settings"),
      ...(["merchant_rfqs", "merchant_quotes", "merchant_transactions"] as const).map(name =>
        this.db.collection(name).find({ merchantId: this.merchantId }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(100).toArray()),
    ]);
    const profile = profiles[0];
    if (!profile || profile.record.mode !== "simulated") throw new MerchantAccessError("Run the demo seed before using the dashboard", 503);
    return { merchantId: this.merchantId, profile, inventory, services, slots, settings: settings[0] ?? null,
      rfqs: rfqs.map(d => rfqSchema.parse(d)), quotes: quotes.map(d => quoteSchema.parse(d)), transactions: transactions.map(d => transactionSchema.parse(d)) };
  }
  async save(resource: AdminResource, input: unknown, expectedVersion: number): Promise<void> {
    const record = adminSchemas[resource].parse(input);
    assertMerchantScope(this.merchantId, record);
    if (record.mode !== "simulated") throw new MerchantAccessError("Demo edits require simulated data", 403);
    z.number().int().nonnegative().parse(expectedVersion);
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        const profileDocument = await this.db.collection("merchant_profiles").findOne({ merchantId: this.merchantId, id: this.merchantId }, { session });
        if (!profileDocument || profileDocument.mode !== "simulated") throw new MerchantAccessError("Seeded simulated profile required", 403);
        if (resource === "profile" && record.id !== this.merchantId) throw new MerchantAccessError();
        if (resource === "profile" && "kind" in record && record.kind !== profileDocument.kind)
          throw new Error("Merchant kind cannot change");
        if ((resource === "inventory" && profileDocument.kind !== "parts") || ((resource === "service" || resource === "slot") && profileDocument.kind !== "repair"))
          throw new Error("Resource does not match merchant kind");
        if (resource === "slot" && "serviceIds" in record) {
          for (const id of record.serviceIds) {
            const service = await this.db.collection("merchant_services").findOne({ merchantId: this.merchantId, id, active: true }, { session });
            if (!service) throw new Error("Slot must reference this merchant's active services");
          }
        }
        const collection = this.db.collection(adminCollections[resource]);
        const previous = await collection.findOne({ merchantId: this.merchantId, id: record.id }, { session });
        if (previous && previous.createdAt !== record.createdAt) throw new Error("Creation timestamp cannot change");
        if (expectedVersion === 0) {
          if (previous) throw new EditConflictError();
          await collection.insertOne({ ...record, _version: 1 }, { session });
        } else {
          const result = await collection.replaceOne({ merchantId: this.merchantId, id: record.id,
            ...(expectedVersion === 1 ? { $or: [{ _version: 1 }, { _version: { $exists: false } }] } : { _version: expectedVersion }) },
          { ...record, _version: expectedVersion + 1 }, { session });
          if (result.matchedCount !== 1) throw new EditConflictError();
        }
        const audit = auditEventSchema.parse({ contractVersion: "1", id: randomUUID(), merchantId: this.merchantId,
          createdAt: new Date().toISOString(), actorId: `demo-admin-${this.merchantId}`, actorKind: "merchant",
          action: auditActions[resource], entityId: record.id, correlationId: randomUUID(), outcome: "success" });
        await this.db.collection("merchant_audit_events").insertOne(audit, { session });
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === 11000) throw new EditConflictError();
      throw error;
    } finally { await session.endSession(); }
  }
}
