import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import type { Db, MongoClient, Document } from "mongodb";
import { demoConfig, issueDemoSession, verifyDemoSession, verifyDemoKey, requireDemoOrigin, DEMO_COOKIE } from "../merchant/server/demo-auth";
import { demoSeedRecords, seedDemoMerchants } from "../merchant/server/seed";
import { MerchantAdminStore, discoverMerchants, EditConflictError, publicProfile } from "../merchant/server/admin-store";
import { inventorySchema, serviceSchema, slotSchema, settingsSchema } from "../merchant/private-contracts";
import { privateMerchant } from "../merchant/server/http";
import { POST as sessionPost } from "../app/api/merchant-demo/session/route";
import { GET as dashboardGet, PUT as dashboardPut } from "../app/api/merchant-demo/dashboard/route";

const env = { NODE_ENV: "test", MERCHANT_DEMO_ENABLED: "true", MERCHANT_DEMO_ACCESS_KEY: "test-access-key-with-at-least-32-chars", MERCHANT_DEMO_SESSION_SECRET: "test-session-secret-with-at-least-32-chars", MERCHANT_DEMO_ORIGIN: "http://localhost:3000" };
const merchantId = "demo-prius-parts";
const config = demoConfig(env);
const now = Date.parse("2026-10-04T12:00:00Z");

test("demo gate is opt-in, loopback only, and always disabled in production", () => {
  assert.throws(() => demoConfig({ ...env, NODE_ENV: "production" }), /disabled/);
  assert.throws(() => demoConfig({ ...env, MERCHANT_DEMO_ENABLED: "false" }), /disabled/);
  assert.throws(() => demoConfig({ ...env, MERCHANT_DEMO_ORIGIN: "https://example.com" }), /loopback/);
  assert.throws(() => demoConfig({ ...env, MERCHANT_DEMO_SESSION_SECRET: "short" }), /incomplete/);
  assert.throws(() => verifyDemoKey("wrong", config), /denied/);
  verifyDemoKey(env.MERCHANT_DEMO_ACCESS_KEY, config);
});
test("signed sessions reject tampering, expiry, arbitrary merchants and wrong secret", () => {
  const token = issueDemoSession(merchantId, config, now);
  assert.equal(verifyDemoSession(token, config, now), merchantId);
  assert.throws(() => verifyDemoSession(token, config, now + 3600000));
  assert.throws(() => verifyDemoSession(token, { ...config, secret: "another-secret" }, now));
  assert.throws(() => verifyDemoSession(`${token}.extra`, config, now));
  const payload = Buffer.from(JSON.stringify({ merchantId: "demo-japan-used", expiresAt: now + 3600000 })).toString("base64url");
  assert.throws(() => verifyDemoSession(`${payload}.${token.split(".")[1]}`, config, now));
  assert.throws(() => issueDemoSession("live-merchant", config, now));
});
test("mutations require configured same origin", () => {
  requireDemoOrigin(new Request(config.origin, { headers: { origin: config.origin } }), config);
  assert.throws(() => requireDemoOrigin(new Request(config.origin, { headers: { origin: "https://evil.example" } }), config));
  assert.throws(() => requireDemoOrigin(new Request("http://evil.example", { headers: { origin: config.origin } }), config));
});
test("private routes reject client merchant IDs, invalid cookies and production demo login", async () => {
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    assert.equal((await dashboardGet(new NextRequest(`${config.origin}/api/merchant-demo/dashboard?merchantId=${merchantId}`))).status, 401);
    assert.equal((await dashboardPut(new NextRequest(`${config.origin}/api/merchant-demo/dashboard`, { method: "PUT", headers: { origin: config.origin, "content-type": "application/json" }, body: JSON.stringify({ merchantId }) }))).status, 401);
    const request = (body: unknown, cookie?: string, origin = config.origin) => new NextRequest(`${config.origin}/api/merchant-demo/session`, { method: "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    assert.equal((await sessionPost(request({ action: "switch", merchantId }))).status, 401);
    assert.equal((await sessionPost(request({ action: "login", merchantId, accessKey: "wrong" }))).status, 401);
    assert.equal((await sessionPost(request({ action: "login", merchantId, accessKey: env.MERCHANT_DEMO_ACCESS_KEY }, undefined, "https://evil.example"))).status, 403);
    const login = await sessionPost(request({ action: "login", merchantId, accessKey: env.MERCHANT_DEMO_ACCESS_KEY }));
    assert.equal(login.status, 200);
    assert.ok(login.headers.get("set-cookie")?.includes("HttpOnly"));
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(privateMerchant(new NextRequest(`${config.origin}/api/merchant-demo/dashboard?merchantId=demo-japan-used`, { headers: { cookie } })), merchantId);
    const foreignRecord = demoSeedRecords().find(r => r.resource === "inventory" && r.record.merchantId === "demo-japan-used")!.record;
    const foreignWrite = await dashboardPut(new NextRequest(`${config.origin}/api/merchant-demo/dashboard`, { method: "PUT", headers: { origin: config.origin, "content-type": "application/json", cookie }, body: JSON.stringify({ resource: "inventory", record: foreignRecord, expectedVersion: 1 }) }));
    assert.equal(foreignWrite.status, 403);
    const switched = await sessionPost(request({ action: "switch", merchantId: "demo-japan-used" }, cookie));
    assert.equal(switched.status, 200);
    const switchedToken = switched.cookies.get(DEMO_COOKIE)!.value;
    assert.equal(verifyDemoSession(switchedToken, config), "demo-japan-used");
    Object.assign(process.env, { NODE_ENV: "production" });
    assert.equal((await sessionPost(request({ action: "login", merchantId, accessKey: env.MERCHANT_DEMO_ACCESS_KEY }))).status, 403);
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
test("seed is deterministic, independent and explicitly simulated", () => {
  const records = demoSeedRecords();
  assert.deepEqual(records, demoSeedRecords());
  const profiles = records.filter(r => r.resource === "profile");
  assert.equal(profiles.filter(p => "kind" in p.record && p.record.kind === "parts").length, 3);
  assert.equal(profiles.filter(p => "kind" in p.record && p.record.kind === "repair").length, 2);
  assert.ok(records.every(r => r.record.mode === "simulated"));
  assert.equal(new Set(records.map(r => `${r.resource}-${r.record.id}`)).size, records.length);
});
test("private schemas validate money floors, stock, slot times and discount limits", () => {
  const records = demoSeedRecords();
  const inventory = records.find(r => r.resource === "inventory")!.record;
  assert.equal(inventorySchema.safeParse({ ...inventory, stock: -1 }).success, false);
  assert.equal(inventorySchema.safeParse({ ...inventory, minimumPrice: { amountMinor: Number.MAX_SAFE_INTEGER, currency: "MNT" } }).success, false);
  const service = records.find(r => r.resource === "service")!.record;
  assert.equal(serviceSchema.safeParse({ ...service, customerSuppliedParts: "anything" }).success, false);
  const slot = records.find(r => r.resource === "slot")!.record;
  assert.equal(slotSchema.safeParse({ ...slot, endsAt: "2026-10-01T00:00:00Z" }).success, false);
  const settings = records.find(r => r.resource === "settings")!.record;
  assert.equal(settingsSchema.safeParse({ ...settings, maxDiscountBps: 10001 }).success, false);
});
test("public profile serialization never exposes inventory or private fields", () => {
  const profile = demoSeedRecords().find(r => r.resource === "profile")!.record;
  const serialized = publicProfile({ ...profile, minimumPrice: 100, inventory: ["secret"], maxDiscountBps: 100, _version: 4 });
  assert.ok(!("minimumPrice" in serialized));
  assert.ok(!("inventory" in serialized));
  assert.ok(!("maxDiscountBps" in serialized));
  assert.ok(!("_version" in serialized));
});

// In-memory MongoDB test double for persistence flow; real driver checks are in the optional replica-set suite.
function memoryMongo() {
  let records: Record<string, Document[]> = {};
  let failAudit = false;
  function matches(record: Document, filter: Document): boolean {
    return Object.entries(filter).every(([key, value]) => key === "$or" ? value.some((branch: Document) => matches(record, branch)) :
      value && typeof value === "object" && "$exists" in value ? (key in record) === value.$exists : record[key] === value);
  }
  const db = { collection(name: string) {
    const rows = () => records[name] ??= [];
    return {
      createIndexes: async () => {},
      find: (filter: Document) => {
        const cursor = { sort: () => cursor, limit: () => cursor, toArray: async () => structuredClone(rows().filter(r => matches(r, filter))) };
        return cursor;
      },
      findOne: async (filter: Document) => structuredClone(rows().find(r => matches(r, filter)) ?? null),
      insertOne: async (record: Document) => {
        if (failAudit && name === "merchant_audit_events") throw new Error("Injected audit persistence failure");
        if (rows().some(r => r.merchantId === record.merchantId && r.id === record.id)) throw Object.assign(new Error("duplicate"), { code: 11000 });
        rows().push(structuredClone(record));
      },
      updateOne: async (filter: Document, update: Document) => {
        if (rows().some(r => matches(r, filter))) return { upsertedCount: 0 };
        rows().push(structuredClone(update.$setOnInsert)); return { upsertedCount: 1 };
      },
      replaceOne: async (filter: Document, record: Document) => {
        const index = rows().findIndex(r => matches(r, filter));
        if (index < 0) return { matchedCount: 0 };
        rows()[index] = structuredClone(record); return { matchedCount: 1 };
      },
    };
  } } as unknown as Db;
  const client = { startSession: () => ({ withTransaction: async (work: () => Promise<void>) => {
    const before = structuredClone(records);
    try { await work(); } catch (error) { records = before; throw error; }
  }, endSession: async () => {} }) } as unknown as MongoClient;
  return { db, client, rows: (name: string) => records[name] ?? [], failAudits: () => { failAudit = true; } };
}
test("saved edits persist across store instances; rerun seed preserves edits", async () => {
  const { db, client, rows } = memoryMongo();
  await seedDemoMerchants(client, db);
  const store = new MerchantAdminStore(client, db, merchantId);
  const item = (await store.list("inventory"))[0];
  await store.save("inventory", { ...item.record, stock: 17, price: { amountMinor: 80000000, currency: "MNT" } }, item.version);
  const saved = (await new MerchantAdminStore(client, db, merchantId).list("inventory"))[0];
  assert.equal(saved.record.stock, 17);
  assert.equal(saved.version, 2);
  assert.equal(rows("merchant_audit_events").filter(a => a.action === "inventory_saved").length, 1);
  const auditsBefore = rows("merchant_audit_events").length;
  await seedDemoMerchants(client, db);
  assert.equal((await store.list("inventory"))[0].record.stock, 17);
  assert.equal(rows("merchant_audit_events").length, auditsBefore);
  await assert.rejects(store.save("inventory", item.record, 1), EditConflictError);
  assert.equal(rows("merchant_audit_events").length, auditsBefore);
});
test("private writes reject another merchant, wrong resource kind and foreign slot services", async () => {
  const { db, client, rows } = memoryMongo();
  await seedDemoMerchants(client, db);
  const store = new MerchantAdminStore(client, db, merchantId);
  const item = (await store.list("inventory"))[0];
  const before = structuredClone(rows("merchant_inventory"));
  await assert.rejects(new MerchantAdminStore(client, db, "demo-japan-used").save("inventory", item.record, item.version), /scope/);
  assert.deepEqual(rows("merchant_inventory"), before);
  const repair = new MerchantAdminStore(client, db, "demo-auto-care");
  await assert.rejects(repair.save("inventory", { ...item.record, merchantId: "demo-auto-care" }, 0), /kind/);
  const slot = (await repair.list("slot"))[0];
  await assert.rejects(repair.save("slot", { ...slot.record, serviceIds: ["demo-quick-garage-service-0"] }, slot.version), /active services/);
  const parts = await new MerchantAdminStore(client, db, "demo-japan-used").list("inventory");
  assert.ok(parts.every(p => p.record.merchantId === "demo-japan-used"));
});
test("discovery returns public capabilities without price, stock or negotiation data", async () => {
  const { db, client } = memoryMongo();
  await seedDemoMerchants(client, db);
  const profiles = await discoverMerchants(db, "parts", "Prius 30");
  assert.equal(profiles.length, 3);
  const serialized = JSON.stringify(profiles);
  for (const key of ["minimumPrice", "stock", "price", "maxDiscountBps", "serviceIds"]) assert.ok(!serialized.includes(key));
});
test("profile, service, slot and settings management persists independently", async () => {
  const { db, client } = memoryMongo();
  await seedDemoMerchants(client, db);
  const store = new MerchantAdminStore(client, db, "demo-auto-care");
  const service = (await store.list("service"))[0];
  await store.save("service", { ...service.record, customerSuppliedParts: "not_accepted", durationMinutes: 120 }, service.version);
  assert.equal((await store.list("service"))[0].record.customerSuppliedParts, "not_accepted");
  const slot = (await store.list("slot"))[0];
  await store.save("slot", { ...slot.record, capacity: 3, status: "blocked" }, slot.version);
  assert.equal((await store.list("slot"))[0].record.status, "blocked");
  const settings = (await store.list("settings"))[0];
  await store.save("settings", { ...settings.record, maxDiscountBps: 250, negotiationEnabled: false }, settings.version);
  assert.equal((await store.list("settings"))[0].record.maxDiscountBps, 250);
  const profile = (await store.list("profile"))[0];
  await store.save("profile", { ...profile.record, capabilities: ["Toyota Prius 30", "painting"], active: false }, profile.version);
  assert.equal((await discoverMerchants(db, "repair")).length, 1);
  assert.equal((await store.snapshot()).profile.record.active, false);
});
test("audit failure rolls back the corresponding private edit", async () => {
  const { db, client, failAudits, rows } = memoryMongo();
  await seedDemoMerchants(client, db);
  const store = new MerchantAdminStore(client, db, merchantId);
  const item = (await store.list("inventory"))[0];
  const count = rows("merchant_audit_events").length;
  failAudits();
  await assert.rejects(store.save("inventory", { ...item.record, stock: 999 }, item.version), /audit persistence/);
  assert.deepEqual((await store.list("inventory"))[0], item);
  assert.equal(rows("merchant_audit_events").length, count);
});
