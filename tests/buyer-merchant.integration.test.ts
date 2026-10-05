import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoClient, type Document } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { createBuyerMerchantGateway } from "../lib/buyer-merchant-client";
import { BuyerMerchantWorkflow, BuyerWorkflowError } from "../lib/buyer-merchant-workflow";
import { authenticateA2A } from "../merchant/a2a/auth";
import { getA2AMerchantDirectory, merchantAgentCardJSON } from "../merchant/a2a/cards";
import { handleMerchantA2A } from "../merchant/a2a/transport";
import { createMerchantRFQProcessor } from "../merchant/a2a/service";
import { handleCommerceMCP } from "../merchant/commerce/mcp";
import { CommerceStore } from "../merchant/commerce/store";
import { seedDemoMerchants } from "../merchant/server/seed";
import { closeMerchantConnection } from "../merchant/server/database";

test("Buyer uses official A2A/MCP SDKs with persisted request ownership and explicit approval", {
  skip: process.env.BUYER_MERCHANT_LOCAL_INTEGRATION !== "true", timeout: 180_000,
}, async t => {
  // Created by this test only: never uses a shared URI or loads .env.local.
  const replica = await MongoMemoryReplSet.create({ instanceOpts: [{ args: ["--nounixsocket"] }], replSet: { count: 1, storageEngine: "wiredTiger", ip: "127.0.0.1" } });
  const client = await new MongoClient(replica.getUri()).connect();
  const db = client.db("buyer_merchant_disposable");
  const oldEnv = { ...process.env };
  const origin = "http://localhost:3000", token = "test-service-token-with-at-least-32-characters", buyerId = "demo-buyer-test";
  const env = { NODE_ENV: "test", BUYER_MERCHANT_ORIGIN: origin, BUYER_MERCHANT_BUYER_ID: buyerId,
    MERCHANT_A2A_ORIGIN: origin, MERCHANT_A2A_AUTH_MODE: "demo", MERCHANT_A2A_DEMO_ENABLED: "true",
    MERCHANT_A2A_DEMO_TOKEN: token, MERCHANT_A2A_DEMO_BUYER_ID: buyerId,
    MERCHANT_MCP_ENABLED: "true", MERCHANT_MCP_AUTH_MODE: "token", MERCHANT_MCP_TOKEN: token,
    MERCHANT_MCP_BUYER_ID: buyerId, MERCHANT_MCP_MERCHANT_IDS: "demo-prius-parts,demo-japan-used,demo-oem-center,demo-auto-care,demo-quick-garage",
    MERCHANT_MCP_APPROVAL_ORIGIN: origin, MONGODB_URI: replica.getUri(), MONGODB_DB: db.databaseName };
  Object.assign(process.env, env);
  const processor = createMerchantRFQProcessor(async () => ({ client, db }));
  const fetchHandler: typeof fetch = async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path === "/api/a2a/discovery") return Response.json(getA2AMerchantDirectory(origin));
    if (path === "/api/mcp/commerce") return handleCommerceMCP(request);
    const route = /^\/api\/a2a\/([^/]+)(\/\.well-known\/agent-card\.json)?$/.exec(path);
    if (!route) return new Response(null, { status: 404 });
    if (route[2]) return Response.json(merchantAgentCardJSON(route[1], origin));
    return handleMerchantA2A(request, route[1], { origin, processRFQ: processor,
      authenticate: (request, merchantId) => authenticateA2A(request, merchantId, env) });
  };
  const gateway = createBuyerMerchantGateway(env, fetchHandler);
  const workflow = new BuyerMerchantWorkflow(db, "owner-a", gateway);
  const goal = { vehicle: "Toyota Prius 30", parts: "Урд бампер, зүүн урд гэрэл", tasks: "Солих, бампер будах", budget: 2_000_000, days: 30, preference: "Any" };
  async function draft(ownerId = "owner-a") {
    const id = randomUUID();
    await db.collection<Document & { _id: string }>("repairRequests").insertOne({ _id: id, ownerId, status: "draft", version: 1, quotes: [], updatedAt: new Date() });
    return id;
  }
  try {
    await seedDemoMerchants(client, db);
    await db.collection("merchant_settings").updateMany({}, { $set: { humanApprovalRequired: false, automaticNegotiationEnabled: true } });

    const foreignId = await draft("owner-b");
    await t.test("foreign owner and incomplete goals cannot obtain repair bundles", async () => {
      await assert.rejects(() => workflow.quotes(foreignId, goal), BuyerWorkflowError);
      const id = await draft();
      const result = await workflow.quotes(id, { ...goal, tasks: "Хөдөлгүүр солих" });
      assert.equal(result.quotes.length, 0);
    });

    const id = await draft();
    const offers = await workflow.quotes(id, goal);
    assert.equal(offers.quotes.length, 6);
    const offered = offers.quotes[0];
    assert.equal(offered.parts + offered.labor, offered.total);
    assert.ok(offered.merchant);

    await t.test("negotiation updates merchant revisions and invalidates overlapping old combinations", async () => {
      const result = await workflow.negotiate(id, offered.token, offered.total - 10_000);
      assert.equal(result.pending, false);
      assert.equal(result.quote.revision, 2);
      assert.ok(result.quote.total <= offered.total);
      const saved = await db.collection<Document & { _id: string }>("repairRequests").findOne({ _id: id });
      assert.ok(saved?.quotes.some((quote: { expiresAt: number }) => quote.expiresAt === 0));
      assert.notEqual(result.quote.token, offered.token);
    });

    const saved = await db.collection<Document & { _id: string }>("repairRequests").findOne({ _id: id });
    const selected = saved!.selectedQuote;
    const commerceStore = new CommerceStore(client, db, origin);
    let checkout: { approvalUrl?: string; transactionId: string };
    await t.test("Confirm creates only an approval link, never an order before the user approves", async () => {
      const result = await workflow.confirm(id, selected.token, selected.total);
      assert.ok("checkout" in result && result.checkout);
      checkout = result.checkout;
      assert.equal(await db.collection("merchant_parts_orders").countDocuments(), 0);
      assert.equal(await db.collection("merchant_repair_bookings").countDocuments(), 0);
      const again = await workflow.confirm(id, selected.token, selected.total);
      assert.ok("checkout" in again);
      assert.equal(again.checkout?.transactionId, checkout.transactionId);
      assert.equal(await db.collection("merchant_commerce_approvals").countDocuments(), 1);
      await assert.rejects(() => workflow.quotes(id, goal), BuyerWorkflowError);
      await assert.rejects(() => workflow.confirm(id, selected.token, selected.total + 1), BuyerWorkflowError);
    });

    await t.test("explicit approval is followed by a persisted order, booking, mock payment and idempotent receipt", async () => {
      const challenge = new URL(checkout!.approvalUrl!).pathname.split("/").pop()!;
      await commerceStore.approveByChallenge(challenge, "approve"); // Models the user's explicit page action.
      const result = await workflow.confirm(id, selected.token, selected.total);
      assert.ok("receipt" in result && result.receipt);
      assert.equal(result.receipt.source, "merchant");
      assert.equal(result.receipt.quote.total, selected.total);
      const again = await workflow.confirm(id, selected.token, selected.total);
      assert.deepEqual(again, result);
      assert.equal(await db.collection("merchant_parts_orders").countDocuments(), 1);
      assert.equal(await db.collection("merchant_repair_bookings").countDocuments(), 1);
      assert.equal(await db.collection("merchant_mock_payments").countDocuments(), 1);
      assert.equal((await db.collection<Document & { _id: string }>("repairRequests").findOne({ _id: id }))?.status, "completed");
    });

    await t.test("pending human negotiations survive retries without generating new IDs", async () => {
      await db.collection("merchant_settings").updateMany({}, { $set: { humanApprovalRequired: true } });
      const pendingId = await draft(), offers = await workflow.quotes(pendingId, goal), offer = offers.quotes[0];
      const target = offer.total - 10000;
      const first = await workflow.negotiate(pendingId, offer.token, target);
      assert.equal(first.pending, true);
      const before = await db.collection<Document & { _id: string }>("repairRequests").findOne({ _id: pendingId });
      const again = await workflow.negotiate(pendingId, offer.token, target);
      assert.equal(again.pending, true);
      const after = await db.collection<Document & { _id: string }>("repairRequests").findOne({ _id: pendingId });
      assert.deepEqual(after?.pendingNegotiation.inputs, before?.pendingNegotiation.inputs);
      await assert.rejects(() => workflow.negotiate(pendingId, offer.token, target - 1), BuyerWorkflowError);
      await assert.rejects(() => workflow.confirm(pendingId, offer.token, offer.total), BuyerWorkflowError);
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    await closeMerchantConnection();
    await client.close();
    await replica.stop();
  }

});
