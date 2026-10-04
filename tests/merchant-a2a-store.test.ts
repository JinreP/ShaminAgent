import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Document, MongoClient } from "mongodb";
import { demoSeedRecords } from "../merchant/server/seed";
import { adminCollections } from "../merchant/server/admin-store";
import { MongoRFQStore, RFQConflictError, RFQ_PROCESSING_COLLECTION, type MerchantRFQData } from "../merchant/a2a/store";
import { merchantRFQResponseSchema, type MerchantRFQEnvelope, type MerchantRFQResponse } from "../merchant/a2a/contracts";

const merchantId = "demo-prius-parts";
const buyerId = "store-test-buyer";
function envelope(): MerchantRFQEnvelope {
  return { contractVersion: "1", correlationId: "store-test-correlation", expiresAt: "2099-10-04T13:00:00Z",
    rfq: { contractVersion: "1", id: "store-test-rfq", merchantId, buyerId, createdAt: "2026-10-04T12:00:00Z",
      kind: "parts", vehicle: { make: "Toyota", model: "Prius 30", year: 2012 },
      items: [{ description: "Тоормосны сэлбэг", quantity: 1 }], status: "received" },
  };
}
function quoted(data: MerchantRFQData, now: Date): MerchantRFQResponse {
  const item = data.inventory[0];
  const request = envelope();
  return { contractVersion: "1", merchantId, rfqId: request.rfq.id, correlationId: request.correlationId,
    outcome: "quoted", message: "Туршилтын үнийн санал бэлэн боллоо.", issues: [],
    quote: { contractVersion: "1", id: "store-test-quote", merchantId, rfqId: request.rfq.id,
      buyerId, createdAt: now.toISOString(), revision: 1, kind: "parts", mode: "simulated",
      lines: [{ resourceId: item.id, description: "Туршилтын сэлбэг", quantity: 1, unitPrice: item.price }],
      total: item.price, expiresAt: new Date(now.getTime() + 600000).toISOString(), availabilityCheckedAt: now.toISOString(),
      reservation: false, terms: "Үнийн санал нь нөөц захиалахгүй.", status: "offered" },
  };
}

// Exercises application transaction behavior only. Real driver guarantees need a disposable replica set.
function memoryMongo(options: { mutateInsertedDocuments?: boolean } = {}) {
  let records: Record<string, Document[]> = {};
  let failAudit = false;
  const seenQueries: { name: string; filter: Document }[] = [];
  const matches = (record: Document, filter: Document) => Object.entries(filter).every(([key, value]) => record[key] === value);
  for (const fixture of demoSeedRecords()) {
    const name = adminCollections[fixture.resource];
    (records[name] ??= []).push({ ...structuredClone(fixture.record), _version: 1 });
  }
  const db = { collection(name: string) {
    const rows = () => records[name] ??= [];
    return {
      find: (filter: Document) => {
        seenQueries.push({ name, filter: structuredClone(filter) });
        return { toArray: async () => structuredClone(rows().filter(r => matches(r, filter))) };
      },
      findOne: async (filter: Document) => {
        seenQueries.push({ name, filter: structuredClone(filter) });
        return structuredClone(rows().find(r => matches(r, filter)) ?? null);
      },
      insertOne: async (record: Document) => {
        if (failAudit && name === "merchant_audit_events") throw new Error("Injected audit failure");
        if (rows().some(r => r.merchantId === record.merchantId && r.id === record.id))
          throw Object.assign(new Error("Duplicate key"), { code: 11000 });
        // The real Node driver mutates the caller's document with an ObjectId.
        if (options.mutateInsertedDocuments && record._id === undefined) record._id = `driver-generated-${rows().length}`;
        rows().push(structuredClone(record));
      },
    };
  } } as unknown as Db;
  const client = { startSession: () => ({ withTransaction: async (work: () => Promise<unknown>) => {
    const before = structuredClone(records);
    try { return await work(); } catch (error) { records = before; throw error; }
  }, endSession: async () => {} }) } as unknown as MongoClient;
  return { db, client, seenQueries, rows: (name: string) => records[name] ?? [],
    insert: (name: string, record: Document) => { (records[name] ??= []).push(record); },
    failAudits: () => { failAudit = true; } };
}

test("A2A RFQ persistence scopes all reads and atomically stores quotes, responses and audits without reservations", async () => {
  const memory = memoryMongo();
  const inventoryBefore = structuredClone(memory.rows("merchant_inventory"));
  const slotsBefore = structuredClone(memory.rows("merchant_slots"));
  const result = await new MongoRFQStore(memory.client, memory.db).processOnce(merchantId, buyerId, envelope(), (data, now) => {
    assert.equal(data.profile?.merchantId, merchantId);
    assert.ok(data.inventory.every(i => i.merchantId === merchantId));
    assert.equal(data.services.length, 0);
    assert.equal(data.slots.length, 0);
    return quoted(data, now);
  });
  assert.equal(result.outcome, "quoted");
  assert.equal(memory.rows("merchant_rfqs")[0].status, "quoted");
  assert.equal(memory.rows("merchant_quotes").length, 1);
  const processed = memory.rows(RFQ_PROCESSING_COLLECTION)[0];
  assert.deepEqual(processed.envelope, envelope());
  assert.deepEqual(processed.response, result);
  assert.equal(processed.buyerId, buyerId);
  assert.equal(processed.quoteRevision, 1);
  assert.match(processed.requestHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(memory.rows("merchant_audit_events").map(a => a.action), ["rfq_received", "quote_created", "rfq_processed"]);
  assert.ok(memory.seenQueries.every(q => q.filter.merchantId === merchantId));
  assert.deepEqual(memory.rows("merchant_inventory"), inventoryBefore);
  assert.deepEqual(memory.rows("merchant_slots"), slotsBefore);
});

test("identical RFQs replay the persisted response across store instances and ignore object property order", async () => {
  const memory = memoryMongo();
  const first = await new MongoRFQStore(memory.client, memory.db).processOnce(merchantId, buyerId, envelope(), quoted);
  const request = envelope();
  const reordered = { rfq: request.rfq, expiresAt: request.expiresAt, correlationId: request.correlationId, contractVersion: request.contractVersion };
  const replay = await new MongoRFQStore(memory.client, memory.db).processOnce(merchantId, buyerId, reordered, () => {
    throw new Error("A duplicate must not compute another quote");
  });
  assert.deepEqual(replay, first);
  assert.equal(memory.rows("merchant_rfqs").length, 1);
  assert.equal(memory.rows("merchant_quotes").length, 1);
  assert.equal(memory.rows("merchant_audit_events").length, 3);
});

test("Mongo insertOne document mutation cannot leak _id into returned or cached A2A responses", async () => {
  const memory = memoryMongo({ mutateInsertedDocuments: true });
  const request = envelope();
  const before = structuredClone(request);
  const store = new MongoRFQStore(memory.client, memory.db);
  const first = await store.processOnce(merchantId, buyerId, request, quoted);
  const cached = memory.rows(RFQ_PROCESSING_COLLECTION)[0];
  assert.ok(memory.rows("merchant_quotes")[0]._id, "The double must reproduce driver mutation");
  assert.ok(cached._id);
  assert.equal(merchantRFQResponseSchema.safeParse(first).success, true);
  assert.equal(merchantRFQResponseSchema.safeParse(cached.response).success, true);
  assert.ok(!Object.hasOwn(first, "_id"));
  assert.ok(!Object.hasOwn(first.quote!, "_id"));
  assert.ok(!Object.hasOwn(cached.response.quote, "_id"));
  assert.deepEqual(request, before);
  const replay = await store.processOnce(merchantId, buyerId, request, () => {
    throw new Error("Duplicate must return the persisted response");
  });
  assert.deepEqual(replay, first);
});

test("RFQ identifiers cannot be reused for conflicting payloads, correlations or authenticated buyers", async () => {
  const memory = memoryMongo();
  const store = new MongoRFQStore(memory.client, memory.db);
  await store.processOnce(merchantId, buyerId, envelope(), quoted);
  const changed = envelope();
  changed.rfq.items[0].quantity = 2;
  await assert.rejects(store.processOnce(merchantId, buyerId, changed, quoted), RFQConflictError);
  await assert.rejects(store.processOnce(merchantId, buyerId, { ...envelope(), correlationId: "other-correlation" }, quoted), RFQConflictError);
  const otherBuyer = envelope();
  otherBuyer.rfq.buyerId = "other-buyer";
  await assert.rejects(store.processOnce(merchantId, "other-buyer", otherBuyer, quoted), RFQConflictError);
  await assert.rejects(store.processOnce("demo-japan-used", buyerId, envelope(), quoted), RFQConflictError);
  assert.equal(memory.rows("merchant_quotes").length, 1);
  assert.equal(memory.rows("merchant_audit_events").length, 3);
});

test("existing RFQ and quote records without an A2A processing record are never overwritten", async () => {
  for (const collection of ["merchant_rfqs", "merchant_quotes"]) {
    const memory = memoryMongo();
    memory.insert(collection, collection === "merchant_rfqs" ? envelope().rfq : { merchantId, rfqId: envelope().rfq.id, id: "legacy-quote" });
    const before = structuredClone(memory.rows(collection));
    await assert.rejects(new MongoRFQStore(memory.client, memory.db).processOnce(merchantId, buyerId, envelope(), quoted), RFQConflictError);
    assert.deepEqual(memory.rows(collection), before);
    assert.equal(memory.rows(RFQ_PROCESSING_COLLECTION).length, 0);
  }
});

test("processing exceptions persist a safe Mongolian failed response and never expose private exception content", async () => {
  const memory = memoryMongo();
  const store = new MongoRFQStore(memory.client, memory.db);
  const result = await store.processOnce(merchantId, buyerId, envelope(), () => {
    throw new Error("mongodb://secret-user:secret-password/private minimumPrice=999");
  });
  assert.equal(result.outcome, "failed");
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.ok(!JSON.stringify(result).includes("minimumPrice"));
  assert.match(result.message, /[А-Яа-яӨөҮү]/);
  assert.equal(memory.rows("merchant_rfqs")[0].status, "declined");
  assert.equal(memory.rows(RFQ_PROCESSING_COLLECTION)[0].status, "failed");
  assert.equal(memory.rows("merchant_quotes").length, 0);
  assert.deepEqual(memory.rows("merchant_audit_events").map(a => a.action), ["rfq_received", "rfq_failed"]);
  assert.deepEqual(await store.processOnce(merchantId, buyerId, envelope(), quoted), result);
});

test("foreign quote references and malformed scoped private data become safe failures", async () => {
  const foreign = memoryMongo();
  const foreignResult = await new MongoRFQStore(foreign.client, foreign.db).processOnce(merchantId, buyerId, envelope(), (data, now) => {
    const response = quoted(data, now);
    response.quote!.lines[0].resourceId = "demo-japan-used-part-0";
    return response;
  });
  assert.equal(foreignResult.outcome, "failed");
  assert.equal(foreign.rows("merchant_quotes").length, 0);
  const malformed = memoryMongo();
  malformed.insert("merchant_inventory", { merchantId, id: "broken-private-item", price: "private-invalid-price" });
  const invalidResult = await new MongoRFQStore(malformed.client, malformed.db).processOnce(merchantId, buyerId, envelope(), quoted);
  assert.equal(invalidResult.outcome, "failed");
  assert.ok(!JSON.stringify(invalidResult).includes("private-invalid-price"));
});

test("audit persistence failure rolls back RFQs, quotes and the processing result", async () => {
  const memory = memoryMongo();
  memory.failAudits();
  await assert.rejects(new MongoRFQStore(memory.client, memory.db).processOnce(merchantId, buyerId, envelope(), quoted), /Injected audit failure/);
  assert.equal(memory.rows("merchant_rfqs").length, 0);
  assert.equal(memory.rows("merchant_quotes").length, 0);
  assert.equal(memory.rows("merchant_audit_events").length, 0);
  assert.equal(memory.rows(RFQ_PROCESSING_COLLECTION).length, 0);
});

test("declined and expired responses persist terminal RFQ status without creating quotes", async () => {
  for (const outcome of ["declined", "expired"] as const) {
    const memory = memoryMongo();
    const result = await new MongoRFQStore(memory.client, memory.db).processOnce(merchantId, buyerId, envelope(), () => ({
      contractVersion: "1", merchantId, rfqId: envelope().rfq.id, correlationId: envelope().correlationId,
      outcome, message: outcome === "expired" ? "Хүсэлтийн хугацаа дууссан байна." : "Худалдаачин хүсэлтийг хүлээн авах боломжгүй байна.",
      issues: [{ code: outcome === "expired" ? "rfq_expired" : "merchant_rejected", message: "Үнийн санал гаргах боломжгүй байна." }],
    }));
    assert.equal(result.outcome, outcome);
    assert.equal(memory.rows("merchant_rfqs")[0].status, outcome);
    assert.equal(memory.rows("merchant_quotes").length, 0);
    assert.equal(memory.rows(RFQ_PROCESSING_COLLECTION)[0].status, outcome);
    assert.deepEqual(memory.rows("merchant_audit_events").map(a => a.action), ["rfq_received", "rfq_processed"]);
  }
});
