import "server-only";
import type { Db, MongoClient } from "mongodb";
import { adminSchemas, type AdminResource, type AdminRecord } from "../private-contracts";
import { DEMO_MERCHANTS } from "./demo-auth";
import { adminCollections } from "./admin-store";
import { initializeMerchantDatabase } from "./database";
import { auditEventSchema } from "../../shared/merchant-contracts";

const createdAt = "2026-10-04T12:00:00Z";
const vehicle = { make: "Toyota", model: "Prius", generation: "30", yearFrom: 2009, yearTo: 2015 };
const mnt = (major: number) => ({ amountMinor: major * 100, currency: "MNT" });
export function demoSeedRecords(): { resource: AdminResource; record: AdminRecord }[] {
  const result: { resource: AdminResource; record: AdminRecord }[] = [];
  const add = (resource: AdminResource, record: unknown) => result.push({ resource, record: adminSchemas[resource].parse(record) });
  for (const [index, merchant] of DEMO_MERCHANTS.entries()) {
    const base = { contractVersion: "1", merchantId: merchant.id, createdAt, mode: "simulated" };
    add("profile", { ...base, id: merchant.id, name: merchant.name, kind: merchant.kind,
      capabilities: merchant.kind === "parts" ? ["Toyota Prius 30", "front bumper", "left front headlight", ["aftermarket", "used", "oem"][index]] :
        ["Toyota Prius 30", "bumper replacement", "headlight replacement", "bumper painting"],
      location: "Ulaanbaatar — simulated demo location", active: true });
    add("settings", { ...base, id: merchant.id, maxDiscountBps: merchant.kind === "parts" ? 400 : 600,
      negotiationEnabled: true, humanApprovalRequired: true });
    if (merchant.kind === "parts") {
      const prices = [[650000, 400000], [550000, 350000], [1100000, 650000]][index];
      for (const [n, name] of ["Front bumper", "Left front headlight"].entries()) {
        add("inventory", { ...base, id: `${merchant.id}-${n === 0 ? "bumper" : "headlight"}`, name,
          partNumber: `SIM-PRIUS30-${index}-${n}`, condition: ["aftermarket", "used", "oem"][index],
          compatibility: [vehicle], price: mnt(prices[n]), minimumPrice: mnt(prices[n] * 0.96),
          stock: index === 1 ? 2 : 5, warranty: `${[3, 1, 6][index]} months — simulated`, active: true });
      }
    } else {
      const names = ["Bumper replacement", "Left headlight replacement", "Bumper painting"];
      const prices = index === 3 ? [150000, 100000, 250000] : [120000, 80000, 200000];
      for (const [n, name] of names.entries()) add("service", { ...base, id: `${merchant.id}-service-${n}`, name,
        vehicles: [vehicle], price: mnt(prices[n]), minimumPrice: mnt(prices[n] * 0.94),
        durationMinutes: [60, 45, 180][n], warranty: "3 months labor — simulated", active: true,
        customerSuppliedParts: index === 3 ? "inspection_required" : "accepted",
        customerPartsTerms: "Simulated policy: fitment inspection required; no warranty on customer-supplied parts." });
      for (let n = 0; n < 3; n++) add("slot", { ...base, id: `${merchant.id}-slot-${n}`,
        serviceIds: names.map((_, i) => `${merchant.id}-service-${i}`), startsAt: `2026-10-${12 + n}T09:00:00+08:00`,
        endsAt: `2026-10-${12 + n}T17:00:00+08:00`, capacity: index === 3 ? 2 : 1, status: "available" });
    }
  }
  return result;
}
export async function seedDemoMerchants(client: MongoClient, db: Db) {
  await initializeMerchantDatabase(db);
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      for (const merchant of DEMO_MERCHANTS) {
        const existing = await db.collection("merchant_profiles").findOne({ merchantId: merchant.id, id: merchant.id }, { session });
        if (existing && (existing.mode !== "simulated" || existing.kind !== merchant.kind))
          throw new Error("Demo identity conflicts with an existing merchant");
      }
      for (const { resource, record } of demoSeedRecords()) {
        const inserted = await db.collection(adminCollections[resource]).updateOne({ merchantId: record.merchantId, id: record.id },
          { $setOnInsert: { ...record, _version: 1 } }, { session, upsert: true });
        if (inserted.upsertedCount) await db.collection("merchant_audit_events").insertOne(auditEventSchema.parse({
          contractVersion: "1", id: `seed-${resource}-${record.id}`, merchantId: record.merchantId, createdAt,
          actorId: "demo-seed", actorKind: "system", action: "demo_seeded", entityId: record.id,
          correlationId: "demo-seed-v1", outcome: "success",
        }), { session });
      }
    });
  } finally { await session.endSession(); }
}
