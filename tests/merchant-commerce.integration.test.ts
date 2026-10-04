import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { authenticateMCP, MCPAuthError } from "../merchant/commerce/auth";
import { CommerceStore, CommerceStoreError } from "../merchant/commerce/store";
import { handleCommerceMCP } from "../merchant/commerce/mcp";
import { createMerchantRFQProcessor } from "../merchant/a2a/service";
import type { MerchantRFQEnvelope } from "../merchant/a2a/contracts";
import { closeMerchantConnection, initializeMerchantDatabase } from "../merchant/server/database";
import { seedDemoMerchants } from "../merchant/server/seed";
import { quoteSchema } from "../shared/merchant-contracts";

const buyerId = "commerce-disposable-buyer";
const partsMerchant = "demo-prius-parts";
const repairMerchant = "demo-auto-care";
const secondRepairMerchant = "demo-quick-garage";
const token = "commerce-test-token-that-is-at-least-thirty-two-characters";

test("commerce flow persists safely in disposable MongoDB and serves official MCP tools", {
  skip: process.env.MERCHANT_COMMERCE_LOCAL_INTEGRATION !== "true",
  timeout: 600000,
}, async t => {
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger", ip: "127.0.0.1" } });
  const client = new MongoClient(replica.getUri());
  const db = client.db("merchant_phase6_disposable");
  const envNames = ["MONGODB_URI", "MONGODB_DB", "MERCHANT_MCP_ENABLED", "MERCHANT_MCP_TOKEN",
    "MERCHANT_MCP_BUYER_ID", "MERCHANT_MCP_MERCHANT_IDS", "MERCHANT_MCP_AUTH_MODE",
    "MERCHANT_MCP_APPROVAL_ORIGIN", "MERCHANT_MCP_ALLOWED_HOSTS"] as const;
  const priorEnv = new Map(envNames.map(name => [name, process.env[name]]));
  const approvalOrigin = "http://localhost";
  const store = new CommerceStore(client, db, approvalOrigin);
  const processor = createMerchantRFQProcessor(async () => ({ client, db }));
  const unique = (prefix: string) => `${prefix}-${randomUUID().replaceAll("-", "")}`;
  let repairWindowCounter = 0;

  async function quote(kind: "parts" | "repair", id: string, merchantId = kind === "parts" ? partsMerchant : repairMerchant) {
    const now = new Date();
    if (kind === "repair") {
      const start = new Date(Date.now() + 86400000 * ++repairWindowCounter);
      const slotId = `${merchantId}-slot-${(repairWindowCounter - 1) % 3}`;
      await db.collection("merchant_slots").updateOne({ merchantId, id: slotId }, {
        $set: { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 8 * 3600000).toISOString(), capacity: 1, status: "available" },
      });
    }
    const envelope: MerchantRFQEnvelope = {
      contractVersion: "1", correlationId: `corr-${id}`, expiresAt: new Date(now.getTime() + 3600000).toISOString(),
      rfq: { contractVersion: "1", id, merchantId, buyerId, createdAt: new Date(now.getTime() - 1000).toISOString(),
        kind, vehicle: { make: "Toyota", model: "Prius", year: 2012 },
        items: [{ description: kind === "parts" ? "Урд гупер" : "Гупер солих", quantity: 1 }], status: "received" },
    };
    const response = await processor(merchantId, buyerId, envelope);
    if ("action" in response) throw new Error("Unexpected non-RFQ A2A response");
    assert.equal(response.outcome, "quoted");
    assert.ok(response.quote);
    return response.quote;
  }

  async function approval(quoteRecord: Awaited<ReturnType<typeof quote>>, transactionId: string, withBooking = false) {
    const selections = [{ merchantId: quoteRecord.merchantId, quoteId: quoteRecord.id, quoteRevision: quoteRecord.revision }];
    const availability = await store.checkAvailability(selections, buyerId, [quoteRecord.merchantId]);
    assert.equal(availability.available, true);
    const created = await store.createApproval({
      transactionId, selections, approvedTotal: quoteRecord.total,
      ...(withBooking ? { booking: availability.bookingWindows[0] } : {}),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    }, buyerId, [quoteRecord.merchantId]);
    const challenge = new URL(created.approvalUrl).pathname.split("/").pop();
    assert.ok(challenge);
    const page = await store.approvalPage(challenge);
    assert.equal(page.page.status, "pending");
    assert.equal("buyerId" in page.page, false);
    assert.equal("selections" in page.page, false);
    await store.approveByChallenge(challenge, "approve");
    return { ...created, challenge, selections };
  }

  async function createQuoteApproval(kind: "parts" | "repair", prefix: string, withBooking = false) {
    const quoteRecord = await quote(kind, unique(prefix));
    const approvalRecord = await approval(quoteRecord, unique("txn"), withBooking);
    return { quote: quoteRecord, approval: approvalRecord };
  }

  try {
    await client.connect();
    await seedDemoMerchants(client, db);
    await db.collection("merchant_inventory").updateMany({ merchantId: partsMerchant }, { $set: { stock: 5 } });

    await t.test("MCP auth is scoped and rejects missing or malformed credentials", () => {
      const config = { NODE_ENV: "test", MERCHANT_MCP_ENABLED: "true", MERCHANT_MCP_TOKEN: token,
        MERCHANT_MCP_BUYER_ID: buyerId, MERCHANT_MCP_MERCHANT_IDS: partsMerchant, MERCHANT_MCP_AUTH_MODE: "token" };
      const request = new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${token}` } });
      assert.deepEqual(authenticateMCP(request, config), { buyerId, merchantIds: [partsMerchant], demo: false });
      assert.throws(() => authenticateMCP(new Request("http://localhost/mcp"), config), MCPAuthError);
      assert.throws(() => authenticateMCP(request, { ...config, MERCHANT_MCP_MERCHANT_IDS: "unknown-merchant" }), MCPAuthError);
    });

    await t.test("parts order requires verified approval, is idempotent, and updates only its merchant dashboard", async () => {
      const { quote: quoteRecord, approval: approved } = await createQuoteApproval("parts", "parts-order");
      await assert.rejects(() => store.createPartsOrder({
        transactionId: approved.transactionId, approvalId: "missing-approval", idempotencyKey: approved.transactionId,
      }, buyerId, [partsMerchant]), CommerceStoreError);
      const request = { transactionId: approved.transactionId, approvalId: approved.approvalId, idempotencyKey: approved.transactionId };
      const first = await store.createPartsOrder(request, buyerId, [partsMerchant]);
      const replay = await store.createPartsOrder(request, buyerId, [partsMerchant]);
      assert.equal(first.orders.length, 1);
      assert.deepEqual(replay, first);
      assert.equal(first.orders[0].quoteId, quoteRecord.id);
      assert.equal((await store.merchantTransactions(partsMerchant)).orders[0].payment, "pending");
      assert.equal((await store.merchantTransactions("demo-japan-used")).orders.length, 0);
      const payment = await store.mockPayment({ ...request, outcome: "succeeded" }, buyerId, [partsMerchant]);
      assert.equal(payment.mode, "simulated");
      assert.equal((await store.mockPayment({ ...request, outcome: "succeeded" }, buyerId, [partsMerchant])).id, payment.id);
      assert.equal((await store.getTransaction(approved.transactionId, buyerId, [partsMerchant])).payment?.id, payment.id);
      await assert.rejects(() => store.getTransaction(approved.transactionId, buyerId, ["demo-japan-used"]),
        (error: unknown) => error instanceof CommerceStoreError && error.code === "unauthorized");
      await store.updateMerchantProgress(partsMerchant, first.orders[0].id, "order", "preparing");
      assert.equal((await store.merchantTransactions(partsMerchant)).orders[0].status, "preparing");
    });

    await t.test("expired and stale quote terms are rejected before reservation", async () => {
      const quoteRecord = await quote("parts", unique("stale-quote"));
      const approvalRecord = await approval(quoteRecord, unique("txn-stale"));
      const inventory = await db.collection("merchant_inventory").findOne({ merchantId: partsMerchant, id: quoteRecord.lines[0].resourceId });
      assert.ok(inventory);
      await db.collection("merchant_inventory").updateOne({ _id: inventory._id }, { $inc: { "price.amountMinor": 100 } });
      await assert.rejects(() => store.createPartsOrder({
        transactionId: approvalRecord.transactionId, approvalId: approvalRecord.approvalId,
        idempotencyKey: approvalRecord.transactionId,
      }, buyerId, [partsMerchant]), (error: unknown) => error instanceof CommerceStoreError && error.code === "stale");
      await db.collection("merchant_inventory").updateOne({ _id: inventory._id }, { $set: { price: inventory.price } });
      await assert.rejects(() => store.createApproval({
        transactionId: unique("txn-expired"), selections: approvalRecord.selections,
        approvedTotal: quoteRecord.total, expiresAt: new Date(Date.now() - 1000).toISOString(),
      }, buyerId, [partsMerchant]), (error: unknown) => error instanceof CommerceStoreError && error.code === "expired");
      await assert.rejects(() => store.createApproval({
        transactionId: unique("txn-unauthorized"), selections: approvalRecord.selections,
        approvedTotal: quoteRecord.total, expiresAt: new Date(Date.now() + 300000).toISOString(),
      }, buyerId, ["demo-japan-used"]), (error: unknown) => error instanceof CommerceStoreError && error.code === "unauthorized");
      const expiredApproval = await store.createApproval({ transactionId: unique("txn-expiring"),
        selections: approvalRecord.selections, approvedTotal: quoteRecord.total,
        expiresAt: new Date(Date.now() + 300000).toISOString() }, buyerId, [partsMerchant]);
      const expiredAt = new Date(Date.now() - 1000);
      await db.collection("merchant_commerce_approvals").updateOne({ id: expiredApproval.approvalId },
        { $set: { createdAt: new Date(expiredAt.getTime() - 300000).toISOString(), expiresAt: expiredAt.toISOString() } });
      await assert.rejects(() => store.approveByChallenge(new URL(expiredApproval.approvalUrl).pathname.split("/").pop()!, "approve"),
        (error: unknown) => error instanceof CommerceStoreError && error.code === "expired");
      const quoteExpiredAt = new Date(Date.now() - 1000);
      await db.collection("merchant_quotes").updateOne({ merchantId: partsMerchant, id: quoteRecord.id },
        { $set: { createdAt: new Date(quoteExpiredAt.getTime() - 300000).toISOString(),
          availabilityCheckedAt: new Date(quoteExpiredAt.getTime() - 301000).toISOString(), expiresAt: quoteExpiredAt.toISOString() } });
      await assert.rejects(() => store.checkAvailability(approvalRecord.selections, buyerId, [partsMerchant]),
        (error: unknown) => error instanceof CommerceStoreError && error.code === "expired");
    });

    await t.test("an explicit user rejection is persisted and approval links are single-use", async () => {
      const quoteRecord = await quote("parts", unique("approval-rejection"));
      const selection = [{ merchantId: partsMerchant, quoteId: quoteRecord.id, quoteRevision: quoteRecord.revision }];
      const created = await store.createApproval({ transactionId: unique("txn-rejected"), selections: selection,
        approvedTotal: quoteRecord.total, expiresAt: new Date(Date.now() + 300000).toISOString() }, buyerId, [partsMerchant]);
      const challenge = new URL(created.approvalUrl).pathname.split("/").pop()!;
      await store.approveByChallenge(challenge, "reject");
      assert.equal((await store.getTransaction(created.transactionId, buyerId, [partsMerchant])).transaction.status, "cancelled");
      await assert.rejects(() => store.approveByChallenge(challenge, "approve"),
        (error: unknown) => error instanceof CommerceStoreError && error.code === "not_found");
    });

    await t.test("stale quote revisions and duplicate approval intents are rejected", async () => {
      const quoteRecord = await quote("parts", unique("stale-revision"));
      const approvalInput = { transactionId: unique("txn-duplicate"), selections: [{
        merchantId: partsMerchant, quoteId: quoteRecord.id, quoteRevision: quoteRecord.revision,
      }], approvedTotal: quoteRecord.total, expiresAt: new Date(Date.now() + 300000).toISOString() };
      await store.createApproval(approvalInput, buyerId, [partsMerchant]);
      await assert.rejects(() => store.createApproval(approvalInput, buyerId, [partsMerchant]),
        (error: unknown) => error instanceof CommerceStoreError && error.code === "conflict");
      await db.collection("merchant_quotes").updateOne({ merchantId: partsMerchant, id: quoteRecord.id },
        { $set: { status: "superseded" } });
      const now = new Date();
      const nextRevision = quoteSchema.parse({ ...quoteRecord, id: unique("quote-revision-2"), revision: 2,
        createdAt: now.toISOString(), availabilityCheckedAt: new Date(now.getTime() - 1000).toISOString(),
        expiresAt: new Date(now.getTime() + 300000).toISOString(), status: "offered" });
      await db.collection("merchant_quotes").insertOne(nextRevision);
      await assert.rejects(() => store.checkAvailability(approvalInput.selections, buyerId, [partsMerchant]),
        (error: unknown) => error instanceof CommerceStoreError && error.code === "stale");
    });

    await t.test("concurrent orders cannot oversell shared inventory", async () => {
      const quoteRecord = await quote("parts", unique("concurrent-stock"));
      await db.collection("merchant_inventory").updateOne({ merchantId: partsMerchant, id: quoteRecord.lines[0].resourceId }, { $set: { stock: 1 } });
      const left = await approval(quoteRecord, unique("txn-left"));
      const right = await approval(quoteRecord, unique("txn-right"));
      const makeOrder = (entry: typeof left) => store.createPartsOrder({
        transactionId: entry.transactionId, approvalId: entry.approvalId, idempotencyKey: entry.transactionId,
      }, buyerId, [partsMerchant]);
      const results = await Promise.allSettled([makeOrder(left), makeOrder(right)]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(await db.collection("merchant_inventory").findOne({ merchantId: partsMerchant, id: quoteRecord.lines[0].resourceId }).then(doc => doc?.stock), 0);
      await db.collection("merchant_inventory").updateOne({ merchantId: partsMerchant, id: quoteRecord.lines[0].resourceId }, { $set: { stock: 5 } });
    });

    await t.test("repair booking reserves a slot once and repeated calls return the same booking", async () => {
      const quoteRecord = await quote("repair", unique("repair-booking"));
      const approved = await approval(quoteRecord, unique("txn-repair"), true);
      const request = { transactionId: approved.transactionId, approvalId: approved.approvalId, idempotencyKey: approved.transactionId };
      const first = await store.bookRepair(request, buyerId, [repairMerchant]);
      const replay = await store.bookRepair(request, buyerId, [repairMerchant]);
      assert.equal(first.id, replay.id);
      assert.equal((await db.collection("merchant_slot_reservation_counters").findOne({ merchantId: repairMerchant }))?.count, 1);
      await store.cancelRepairBooking(approved.transactionId, approved.approvalId, buyerId, [repairMerchant]);
      await db.collection("merchant_slots").updateOne({ merchantId: repairMerchant, id: `${repairMerchant}-slot-0` }, { $set: { status: "blocked" } });
      await db.collection("merchant_slots").updateOne({ merchantId: repairMerchant, id: `${repairMerchant}-slot-1` }, { $set: { status: "blocked" } });
    });

    await t.test("concurrent repair bookings cannot exceed slot capacity", async () => {
      const quoteRecord = await quote("repair", unique("concurrent-booking"));
      const left = await approval(quoteRecord, unique("txn-booking-left"), true);
      const right = await approval(quoteRecord, unique("txn-booking-right"), true);
      const book = (entry: typeof left) => store.bookRepair({
        transactionId: entry.transactionId, approvalId: entry.approvalId, idempotencyKey: entry.transactionId,
      }, buyerId, [repairMerchant]);
      const results = await Promise.allSettled([book(left), book(right)]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      const winner = results[0].status === "fulfilled" ? left : right;
      const bookingRecord = await db.collection("merchant_repair_bookings").findOne({ transactionId: winner.transactionId });
      assert.ok(bookingRecord);
      const counter = await db.collection("merchant_slot_reservation_counters").findOne({ merchantId: repairMerchant, id: bookingRecord.slotId });
      assert.equal(counter?.count, 1);
      await db.collection("merchant_slots").updateOne({ merchantId: repairMerchant, id: bookingRecord.slotId }, { $set: { status: "blocked" } });
    });

    await t.test("failed repair booking compensates a previously reserved parts order", async () => {
      const partsQuote = await quote("parts", unique("mixed-parts"));
      const repairQuote = await quote("repair", unique("mixed-repair"));
      const selections = [
        { merchantId: partsQuote.merchantId, quoteId: partsQuote.id, quoteRevision: partsQuote.revision },
        { merchantId: repairQuote.merchantId, quoteId: repairQuote.id, quoteRevision: repairQuote.revision },
      ];
      const availability = await store.checkAvailability(selections, buyerId, [partsMerchant, repairMerchant]);
      const approved = await store.createApproval({ transactionId: unique("txn-compensate"), selections,
        approvedTotal: availability.total, booking: availability.bookingWindows[0],
        expiresAt: new Date(Date.now() + 300000).toISOString() }, buyerId, [partsMerchant, repairMerchant]);
      const challenge = new URL(approved.approvalUrl).pathname.split("/").pop()!;
      await store.approveByChallenge(challenge, "approve");
      const orderResult = await store.createPartsOrder({ transactionId: approved.transactionId, approvalId: approved.approvalId,
        idempotencyKey: approved.transactionId }, buyerId, [partsMerchant, repairMerchant]);
      const inventoryId = partsQuote.lines[0].resourceId;
      const before = await db.collection("merchant_inventory").findOne({ merchantId: partsMerchant, id: inventoryId });
      assert.ok(before);
      await db.collection("merchant_slots").updateOne({ merchantId: repairMerchant, startsAt: availability.bookingWindows[0].startsAt },
        { $set: { status: "blocked" } });
      await assert.rejects(() => store.bookRepair({ transactionId: approved.transactionId, approvalId: approved.approvalId,
        idempotencyKey: approved.transactionId }, buyerId, [partsMerchant, repairMerchant]));
      assert.equal((await db.collection("merchant_parts_orders").findOne({ transactionId: approved.transactionId }))?.status, "cancelled");
      assert.equal((await db.collection("merchant_inventory").findOne({ merchantId: partsMerchant, id: inventoryId }))?.stock, before.stock + 1);
      assert.equal(orderResult.orders.length, 1);
    });

    await t.test("combined transaction cancellation releases parts and repair reservations together", async () => {
      const partsQuote = await quote("parts", unique("cancel-combined-parts"));
      const repairQuote = await quote("repair", unique("cancel-combined-repair"), secondRepairMerchant);
      const selections = [
        { merchantId: partsMerchant, quoteId: partsQuote.id, quoteRevision: partsQuote.revision },
        { merchantId: secondRepairMerchant, quoteId: repairQuote.id, quoteRevision: repairQuote.revision },
      ];
      const availability = await store.checkAvailability(selections, buyerId, [partsMerchant, secondRepairMerchant]);
      assert.equal(availability.available, true);
      const approved = await store.createApproval({ transactionId: unique("txn-cancel-combined"), selections,
        approvedTotal: availability.total, booking: availability.bookingWindows[0],
        expiresAt: new Date(Date.now() + 300000).toISOString() }, buyerId, [partsMerchant, secondRepairMerchant]);
      const challenge = new URL(approved.approvalUrl).pathname.split("/").pop()!;
      await store.approveByChallenge(challenge, "approve");
      const partsBefore = await db.collection("merchant_inventory").findOne({ merchantId: partsMerchant, id: partsQuote.lines[0].resourceId });
      assert.ok(partsBefore);
      await store.createPartsOrder({ transactionId: approved.transactionId, approvalId: approved.approvalId,
        idempotencyKey: approved.transactionId }, buyerId, [partsMerchant, secondRepairMerchant]);
      await store.bookRepair({ transactionId: approved.transactionId, approvalId: approved.approvalId,
        idempotencyKey: approved.transactionId }, buyerId, [partsMerchant, secondRepairMerchant]);
      const cancelled = await store.cancelTransaction(approved.transactionId, approved.approvalId, buyerId,
        [partsMerchant, secondRepairMerchant]);
      assert.equal(cancelled.transaction.status, "cancelled");
      assert.equal(cancelled.orders[0].status, "cancelled");
      assert.equal(cancelled.bookings[0].status, "cancelled");
      assert.equal((await db.collection("merchant_inventory").findOne({ merchantId: partsMerchant, id: partsQuote.lines[0].resourceId }))?.stock,
        partsBefore.stock);
    });

    await t.test("failed mock payment releases reservations and recovery failures remain visible", async () => {
      const { approval: approved } = await createQuoteApproval("parts", "payment-failure");
      const order = await store.createPartsOrder({ transactionId: approved.transactionId, approvalId: approved.approvalId,
        idempotencyKey: approved.transactionId }, buyerId, [partsMerchant]);
      const payment = await store.mockPayment({ transactionId: approved.transactionId, approvalId: approved.approvalId,
        idempotencyKey: approved.transactionId, outcome: "failed" }, buyerId, [partsMerchant]);
      assert.equal(payment.outcome, "failed");
      assert.equal((await db.collection("merchant_parts_orders").findOne({ id: order.orders[0].id }))?.status, "cancelled");

      const { quote: quoteRecord, approval: secondApproval } = await createQuoteApproval("parts", "recovery-failure");
      const secondOrder = await store.createPartsOrder({ transactionId: secondApproval.transactionId, approvalId: secondApproval.approvalId,
        idempotencyKey: secondApproval.transactionId }, buyerId, [partsMerchant]);
      const inventory = await db.collection("merchant_inventory").findOne({ merchantId: partsMerchant, id: quoteRecord.lines[0].resourceId });
      assert.ok(inventory);
      await db.collection("merchant_inventory").deleteOne({ merchantId: partsMerchant, id: quoteRecord.lines[0].resourceId });
      await assert.rejects(() => store.cancelPartsOrder(secondApproval.transactionId, secondApproval.approvalId, buyerId, [partsMerchant]),
        (error: unknown) => error instanceof CommerceStoreError && error.code === "recovery_required");
      assert.equal((await db.collection("merchant_parts_orders").findOne({ id: secondOrder.orders[0].id }))?.status, "recovery_required");
      assert.equal(await db.collection("merchant_compensation_attempts").countDocuments({ transactionId: secondApproval.transactionId, status: "failed" }), 1);
      await db.collection("merchant_inventory").insertOne(inventory);
    });

    await t.test("official MCP client initializes, lists and invokes scoped tools", async () => {
      await initializeMerchantDatabase(db);
      process.env.MONGODB_URI = replica.getUri();
      process.env.MONGODB_DB = db.databaseName;
      process.env.MERCHANT_MCP_ENABLED = "true";
      process.env.MERCHANT_MCP_TOKEN = token;
      process.env.MERCHANT_MCP_BUYER_ID = buyerId;
      process.env.MERCHANT_MCP_MERCHANT_IDS = partsMerchant;
      process.env.MERCHANT_MCP_AUTH_MODE = "token";
      process.env.MERCHANT_MCP_APPROVAL_ORIGIN = approvalOrigin;
      const fetchHandler: typeof fetch = async (input, init) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
        return handleCommerceMCP(request);
      };
      const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp/commerce"), {
        fetch: fetchHandler,
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      const mcpClient = new Client({ name: "commerce-test-buyer", version: "1.0.0" });
      try {
        await mcpClient.connect(transport);
        const tools = await mcpClient.listTools();
        assert.ok(tools.tools.some(tool => tool.name === "create_parts_order"));
        assert.ok(tools.tools.some(tool => tool.name === "mock_payment"));
        const quoteRecord = await quote("parts", unique("mcp-tool"));
        const response = await mcpClient.callTool({ name: "check_availability",
          arguments: { selections: [{ merchantId: partsMerchant, quoteId: quoteRecord.id, quoteRevision: quoteRecord.revision }] } });
        assert.equal(response.isError, undefined);
        assert.ok(Array.isArray(response.content));
        const textContent = response.content.find((content): content is { type: "text"; text: string } =>
          typeof content === "object" && content !== null && "type" in content && content.type === "text" &&
          "text" in content && typeof content.text === "string");
        assert.ok(textContent);
        assert.equal(JSON.parse(textContent.text).available, true);
        const foreignQuote = await quote("parts", unique("mcp-foreign"), "demo-japan-used");
        const denied = await mcpClient.callTool({ name: "check_availability",
          arguments: { selections: [{ merchantId: foreignQuote.merchantId, quoteId: foreignQuote.id, quoteRevision: foreignQuote.revision }] } });
        assert.equal(denied.isError, true);
      } finally {
        await mcpClient.close();
        await transport.close();
      }
    });
  } finally {
    await closeMerchantConnection();
    await client.close();
    await replica.stop();
    for (const name of envNames) {
      const value = priorEnv.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
