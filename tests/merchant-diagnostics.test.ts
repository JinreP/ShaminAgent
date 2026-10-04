import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "mongodb";
import { explainMerchantFailure, formatMerchantFailure } from "../merchant/server/diagnostics";
import { MerchantAccessError } from "../merchant/server/demo-auth";
import { readDatabaseEnv } from "../merchant/server/env";
import { inspectSeedTarget } from "../merchant/server/seed-check";
import { demoSeedRecords } from "../merchant/server/seed";
import { adminCollections } from "../merchant/server/admin-store";
import { merchantIndexes } from "../merchant/server/database";

const secret = "private-diagnostic-secret-do-not-log";
const uri = `mongodb+srv://private-user:${secret}@private-cluster.example/test`;
function rawError(code?: string | number, name = "MongoServerError") {
  return Object.assign(new Error(`Raw private error ${uri}`), {
    name, ...(code === undefined ? {} : { code }), stack: `Private stack ${secret}`,
  });
}
function assertRedacted(error: unknown, category: string) {
  const failure = explainMerchantFailure(error);
  assert.equal(failure.category, category);
  const output = `${JSON.stringify(failure)} ${formatMerchantFailure(error, "connection")}`;
  for (const value of [secret, uri, "private-user", "private-cluster.example", "Raw private error", "Private stack"])
    assert.ok(!output.includes(value), `Diagnostic exposed ${value}`);
  return failure;
}

test("diagnostics recover nested TLS topology causes without printing driver details", () => {
  const ssl = rawError("ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR", "Error");
  const topology = { servers: new Map([["private-cluster.example:27017", { error: { cause: ssl } }]]) };
  const error = Object.assign(rawError(undefined, "MongoServerSelectionError"), { reason: topology });
  const failure = assertRedacted(error, "tls");
  assert.deepEqual(failure.codes, ["ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR"]);
  assert.match(failure.message, /before authentication/);
});

test("diagnostics distinguish authentication, authorization, topology and duplicate keys", () => {
  for (const [code, category] of [[18, "authentication"], [13, "authorization"], [20, "topology"], [11000, "duplicate_key"]] as const) {
    const failure = assertRedacted(Object.assign(rawError(), { cause: rawError(code) }), category);
    assert.deepEqual(failure.codes, [code]);
  }
});

test("database environment diagnostics report missing variable names only", () => {
  let error: unknown;
  try { readDatabaseEnv({}); } catch (caught) { error = caught; }
  assert.ok(error instanceof Error);
  const failure = assertRedacted(error, "database_configuration");
  assert.match(failure.message, /MONGODB_URI/);
  assert.match(failure.message, /MONGODB_DB/);
  const hostile = new Error(`Invalid database environment: MONGODB_URI, ${uri}`);
  assertRedacted(hostile, "database_configuration");
});

test("demo configuration diagnostics allowlist missing settings", () => {
  const failure = assertRedacted(new MerchantAccessError(
    `Merchant demo configuration is incomplete: MERCHANT_DEMO_ORIGIN, MERCHANT_DEMO_ACCESS_KEY, MERCHANT_DEMO_SESSION_SECRET; ${uri}`, 503,
  ), "demo_configuration");
  for (const name of ["MERCHANT_DEMO_ORIGIN", "MERCHANT_DEMO_ACCESS_KEY", "MERCHANT_DEMO_SESSION_SECRET"])
    assert.match(failure.message, new RegExp(name));
  assert.match(failure.hint!, /32 characters/);
});

test("unknown errors and arbitrary error codes cannot expose credentials", () => {
  const error = rawError(uri);
  error.cause = error;
  const failure = assertRedacted(error, "unknown");
  assert.deepEqual(failure.codes, []);
});

type Row = Record<string, unknown>;
function readOnlyMongo(options: {
  rows?: Record<string, Row[]>;
  collections?: string[];
  indexes?: Record<string, Row[]>;
} = {}) {
  const rows = structuredClone(options.rows ?? {});
  const collections = options.collections ?? Object.keys(merchantIndexes);
  const indexes = options.indexes ?? Object.fromEntries(Object.entries(merchantIndexes).map(([name, expected]) => [name, structuredClone(expected)]));
  let mutations = 0;
  let indexesRead = 0;
  const forbidden = () => { mutations++; throw new Error("A read-only inspection attempted a mutation"); };
  const db = {
    listCollections: () => ({ toArray: async () => collections.map(name => ({ name })) }),
    collection: (name: string) => new Proxy({
      findOne: async (filter: Row) => structuredClone(rows[name]?.find(row => Object.entries(filter).every(([key, value]) => row[key] === value)) ?? null),
      listIndexes: () => {
        assert.ok(collections.includes(name), "Inspector listed indexes of a missing collection");
        indexesRead++;
        return { toArray: async () => structuredClone(indexes[name] ?? []) };
      },
    }, { get(target, property) { return property in target ? target[property as keyof typeof target] : forbidden; } }),
    createCollection: forbidden,
    dropDatabase: forbidden,
  } as unknown as Db;
  return { db, rows, mutations: () => mutations, indexesRead: () => indexesRead };
}
function seededRows() {
  const rows: Record<string, Row[]> = {};
  for (const { resource, record } of demoSeedRecords())
    (rows[adminCollections[resource]] ??= []).push({ ...record, _id: `mock-${record.id}`, _version: 1 });
  return rows;
}

test("seed inspection counts pending fixtures without writes or initialization", async () => {
  const mock = readOnlyMongo();
  const before = structuredClone(mock.rows);
  const result = await inspectSeedTarget(mock.db);
  assert.equal(result.pendingRecords, demoSeedRecords().length);
  assert.equal(result.existingRecords, 0);
  assert.equal(result.fixtureConflicts, 0);
  assert.equal(result.retainedAuditConflicts, 0);
  assert.equal(result.collectionsMissing, 0);
  assert.equal(result.expectedIndexesMissing, 0);
  assert.equal(mock.mutations(), 0);
  assert.deepEqual(mock.rows, before);
});

test("seed inspection accepts valid existing fixtures and preserves edited values", async () => {
  const rows = seededRows();
  rows.merchant_inventory[0].stock = 37;
  rows.merchant_inventory[0]._version = 2;
  const mock = readOnlyMongo({ rows });
  const before = structuredClone(mock.rows);
  const result = await inspectSeedTarget(mock.db);
  assert.equal(result.existingRecords, demoSeedRecords().length);
  assert.equal(result.pendingRecords, 0);
  assert.equal(result.fixtureConflicts, 0);
  assert.equal(result.retainedAuditConflicts, 0);
  assert.equal(mock.mutations(), 0);
  assert.deepEqual(mock.rows, before);
});

test("seed inspection detects live and malformed private fixture collisions safely", async () => {
  const rows = seededRows();
  rows.merchant_inventory[0].mode = "live";
  rows.merchant_inventory[0].warranty = secret;
  rows.merchant_services[0].durationMinutes = -1;
  const mock = readOnlyMongo({ rows });
  const result = await inspectSeedTarget(mock.db);
  assert.equal(result.fixtureConflicts, 2);
  assert.ok(result.warnings.some(warning => /do not seed/.test(warning)));
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(mock.mutations(), 0);
});

test("seed inspection detects absent fixture with retained deterministic audit", async () => {
  const rows = seededRows();
  const removed = rows.merchant_inventory.shift()!;
  rows.merchant_audit_events = [{ merchantId: removed.merchantId, id: `seed-inventory-${removed.id}`, privateValue: secret }];
  const mock = readOnlyMongo({ rows });
  const result = await inspectSeedTarget(mock.db);
  assert.equal(result.pendingRecords, 1);
  assert.equal(result.retainedAuditConflicts, 1);
  assert.ok(result.warnings.some(warning => /duplicate key/.test(warning)));
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(mock.mutations(), 0);
});

test("seed inspection reports missing collections and indexes without creating them", async () => {
  const empty = readOnlyMongo({ collections: [] });
  const result = await inspectSeedTarget(empty.db);
  assert.equal(result.databaseAlreadyExists, false);
  assert.equal(result.collectionsMissing, Object.keys(merchantIndexes).length);
  assert.equal(result.expectedIndexesMissing, Object.values(merchantIndexes).reduce((sum, indexes) => sum + indexes.length, 0));
  assert.equal(empty.indexesRead(), 0);
  assert.equal(empty.mutations(), 0);
  assert.ok(result.warnings.some(warning => /shared-database review/.test(warning)));
  const missingIndex = readOnlyMongo({ indexes: { ...Object.fromEntries(Object.entries(merchantIndexes)), merchant_inventory: [] } });
  const partial = await inspectSeedTarget(missingIndex.db);
  assert.equal(partial.collectionsMissing, 0);
  assert.equal(partial.expectedIndexesMissing, 1);
  assert.equal(missingIndex.mutations(), 0);
});

test("seed inspection warns about existing named index conflicts", async () => {
  const indexes = Object.fromEntries(Object.entries(merchantIndexes));
  const mock = readOnlyMongo({ indexes: { ...indexes, merchant_inventory: [{ name: "merchant_identity", key: { id: 1 }, unique: true }] } });
  const result = await inspectSeedTarget(mock.db);
  assert.equal(result.expectedIndexesMissing, 1);
  assert.ok(result.warnings.some(warning => /named index conflicts/.test(warning)));
  assert.equal(mock.mutations(), 0);
});

test("seed inspection rejects index options that alter identity or retention behavior", async () => {
  for (const options of [{ sparse: true }, { partialFilterExpression: { active: true } }, { expireAfterSeconds: 3600 }, { collation: { locale: "en", strength: 2 } }]) {
    const indexes = Object.fromEntries(Object.entries(merchantIndexes));
    const mock = readOnlyMongo({ indexes: { ...indexes, merchant_inventory: [{ ...merchantIndexes.merchant_inventory[0], ...options }] } });
    const result = await inspectSeedTarget(mock.db);
    assert.equal(result.expectedIndexesMissing, 1);
    assert.ok(result.warnings.some(warning => /index keys have conflicting/.test(warning)));
    assert.equal(mock.mutations(), 0);
  }
});
