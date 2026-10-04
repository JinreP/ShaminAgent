import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { seedDemoMerchants } from "../merchant/server/seed";
import { MerchantAdminStore, discoverMerchants, EditConflictError } from "../merchant/server/admin-store";

test("replica set persists dashboard edits, isolates merchants and preserves seeds", { skip: !process.env.MERCHANT_TEST_MONGODB_URI }, async () => {
  const client = new MongoClient(process.env.MERCHANT_TEST_MONGODB_URI!);
  const db = client.db(`merchant_phase2_${randomUUID().replaceAll("-", "")}`);
  try {
    await client.connect();
    await seedDemoMerchants(client, db);
    assert.equal((await discoverMerchants(db)).length, 5);
    const parts = new MerchantAdminStore(client, db, "demo-prius-parts");
    const item = (await parts.list("inventory"))[0];
    await parts.save("inventory", { ...item.record, stock: 23 }, item.version);
    const restarted = new MongoClient(process.env.MERCHANT_TEST_MONGODB_URI!);
    try {
      await restarted.connect();
      const reloaded = await new MerchantAdminStore(restarted, restarted.db(db.databaseName), "demo-prius-parts").list("inventory");
      assert.equal(reloaded[0].record.stock, 23);
    } finally { await restarted.close(); }
    await assert.rejects(parts.save("inventory", item.record, item.version), EditConflictError);
    await assert.rejects(new MerchantAdminStore(client, db, "demo-japan-used").save("inventory", item.record, item.version), /scope/);
    await seedDemoMerchants(client, db);
    assert.equal((await parts.list("inventory"))[0].record.stock, 23);
    assert.equal(await db.collection("merchant_audit_events").countDocuments({ action: "inventory_saved" }), 1);
    const repair = new MerchantAdminStore(client, db, "demo-auto-care");
    const slot = (await repair.list("slot"))[0];
    await repair.save("slot", { ...slot.record, status: "blocked" }, slot.version);
    assert.equal((await repair.list("slot"))[0].record.status, "blocked");
    await assert.rejects(repair.save("slot", { ...slot.record, serviceIds: ["demo-quick-garage-service-0"] }, 2), /active services/);
    assert.ok((await repair.snapshot()).inventory.length === 0);
  } finally { await db.dropDatabase(); await client.close(); }
});
