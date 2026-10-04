import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { randomUUID } from "node:crypto";
import { initializeMerchantDatabase } from "../merchant/server/database";
import { MerchantRepository } from "../merchant/server/repository";

test("MongoDB indexes, isolation and atomic audit persistence", { skip: !process.env.MERCHANT_TEST_MONGODB_URI }, async () => {
  const client = new MongoClient(process.env.MERCHANT_TEST_MONGODB_URI!);
  const db = client.db(`merchant_test_${randomUUID().replaceAll("-", "")}`);
  try {
    await client.connect();
    await initializeMerchantDatabase(db);
    await initializeMerchantDatabase(db);
    const repo = new MerchantRepository(client, db, "m1");
    const now = new Date().toISOString();
    const profile = { contractVersion: "1" as const, id: "m1", merchantId: "m1", createdAt: now, name: "TEST FIXTURE", kind: "parts" as const, mode: "simulated" as const, capabilities: ["parts"], location: "Test only", active: true };
    const audit = { contractVersion: "1" as const, id: "a1", merchantId: "m1", createdAt: now, actorId: "m1", actorKind: "merchant" as const, action: "profile_saved" as const, entityId: "m1", correlationId: "test1", outcome: "success" as const };
    await repo.insertAudited("merchant_profiles", profile, audit);
    assert.equal((await repo.findById("merchant_profiles", "m1"))?.name, "TEST FIXTURE");
    assert.equal(await new MerchantRepository(client, db, "m2").findById("merchant_profiles", "m1"), null);
    await assert.rejects(repo.insertAudited("merchant_profiles", profile, { ...audit, id: "a2" }));
    assert.equal(await db.collection("merchant_audit_events").countDocuments({ id: "a2" }), 0);
    const txn = db.collection("merchant_transactions");
    await txn.insertOne({ merchantId: "m1", id: "t1", idempotencyKey: "k1", approvalId: "ap1", buyerId: "b1", quoteId: "q1", quoteRevision: 1, kind: "parts_order" });
    await assert.rejects(txn.insertOne({ merchantId: "m1", id: "t2", idempotencyKey: "k1", approvalId: "ap2", buyerId: "b1", quoteId: "q2", quoteRevision: 1, kind: "parts_order" }));
  } finally { await db.dropDatabase(); await client.close(); }
});
