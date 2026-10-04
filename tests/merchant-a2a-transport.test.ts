import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentCard, SendMessageRequest } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { A2A_ERROR_CODE } from "@a2a-js/sdk/errors";
import { A2AAuthError } from "../merchant/a2a/auth";
import { getA2AMerchantDirectory, getMerchantAgentCard, merchantAgentCardJSON } from "../merchant/a2a/cards";
import { merchantRFQResponseSchema, type MerchantRFQResponse } from "../merchant/a2a/contracts";
import { RFQInputError } from "../merchant/a2a/service";
import { handleMerchantA2A, type MerchantA2ADependencies } from "../merchant/a2a/transport";
import { DEMO_MERCHANTS } from "../merchant/demo-merchants";

const origin = "http://localhost:3000";
const merchantId = "demo-prius-parts";
const buyerId = "test-buyer";
const envelope = {
  contractVersion: "1", correlationId: "test-correlation", expiresAt: "2026-10-20T00:00:00Z",
  rfq: {
    contractVersion: "1", id: "test-rfq", merchantId, buyerId, createdAt: "2026-10-04T12:00:00Z",
    kind: "parts", vehicle: { make: "Toyota", model: "Prius", year: 2012 },
    items: [{ description: "Урд гупер", quantity: 1 }], status: "received",
  },
};
function responseFor(id: string): MerchantRFQResponse {
  return {
    contractVersion: "1", merchantId: id, rfqId: "test-rfq", correlationId: "test-correlation",
    outcome: "declined", message: "Хүссэн сэлбэг боломжгүй байна.",
    issues: [{ code: "item_unavailable", message: "Сэлбэг олдсонгүй." }],
  };
}
function dependencies(overrides: MerchantA2ADependencies = {}): MerchantA2ADependencies {
  return { origin, authenticate: async () => ({ buyerId, allowedMerchantIds: DEMO_MERCHANTS.map(m => m.id) }),
    processRFQ: async id => responseFor(id), ...overrides };
}
function rpcBody(method = "SendMessage", params: unknown = {
  message: { messageId: "test-message", role: "ROLE_USER", parts: [{ data: envelope, mediaType: "application/json" }] },
}) { return { jsonrpc: "2.0", id: "rpc-test", method, params }; }
function request(body: unknown = rpcBody(), headers: Record<string, string> = {}): Request {
  return new Request(`${origin}/api/a2a/${merchantId}`, { method: "POST", headers: {
    "content-type": "application/json", "A2A-Version": "1.0", authorization: "Bearer test-only-credential", ...headers,
  }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
async function result(body: unknown = rpcBody(), overrides: MerchantA2ADependencies = {}, headers: Record<string, string> = {}) {
  const response = await handleMerchantA2A(request(body, headers), merchantId, dependencies(overrides));
  return { response, body: await response.json() };
}

test("five independent official Agent Cards contain only public capability information", () => {
  const directory = getA2AMerchantDirectory(origin);
  assert.equal(directory.merchants.length, 5);
  assert.equal(directory.merchants.filter(m => m.kind === "parts").length, 3);
  assert.equal(directory.merchants.filter(m => m.kind === "repair").length, 2);
  assert.equal(new Set(directory.merchants.map(m => m.a2aUrl)).size, 5);
  for (const merchant of directory.merchants) {
    const card = AgentCard.fromJSON(merchantAgentCardJSON(merchant.merchantId, origin));
    assert.deepEqual(card.supportedInterfaces.map(i => [i.url, i.protocolBinding, i.protocolVersion]), [[merchant.a2aUrl, "JSONRPC", "1.0"]]);
    assert.equal(card.capabilities?.streaming, false);
    assert.equal(card.capabilities?.pushNotifications, false);
    assert.match(card.description, /дуураймал/);
    assert.equal(card.securitySchemes.merchantBearer.scheme?.$case, "httpAuthSecurityScheme");
    assert.ok(card.skills.every(s => s.id.startsWith(merchant.merchantId)));
    const wire = JSON.stringify(card);
    for (const privateField of ["minimumPrice", "maxDiscountBps", "stock", "minimumTotal", "GEMINI_API_KEY", "MONGODB_URI"]) assert.ok(!wire.includes(privateField));
  }
  assert.throws(() => getMerchantAgentCard("unknown-merchant", origin));
});

test("official A2A SDK Buyer client exchanges structured Messages with independently scoped merchants", async () => {
  const calls: { merchantId: string; buyerId: string; input: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const httpRequest = new Request(input, init);
    const id = new URL(httpRequest.url).pathname.split("/").at(-1)!;
    assert.equal(httpRequest.headers.get("A2A-Version"), "1.0");
    return handleMerchantA2A(httpRequest, id, dependencies({
      processRFQ: async (scope, buyer, payload) => { calls.push({ merchantId: scope, buyerId: buyer, input: payload }); return responseFor(scope); },
    }));
  };
  const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })] });
  for (const merchant of DEMO_MERCHANTS) {
    const client = await factory.createFromAgentCard(getMerchantAgentCard(merchant.id, origin));
    const payload = { ...envelope, rfq: { ...envelope.rfq, merchantId: merchant.id } };
    const response = await client.sendMessage(SendMessageRequest.fromJSON({
      message: { messageId: `message-${merchant.id}`, role: "ROLE_USER", parts: [{ data: payload, mediaType: "application/json" }] },
    }), { serviceParameters: { Authorization: "Bearer test-only-credential" } });
    assert.ok("messageId" in response);
    if (!("messageId" in response)) throw new Error("Expected immediate Message");
    assert.equal(response.taskId, "");
    assert.equal(response.parts[0].content?.$case, "data");
    const domain = merchantRFQResponseSchema.parse(response.parts[0].content?.value);
    assert.equal(domain.merchantId, merchant.id);
    assert.match(domain.message, /[А-Яа-яӨөҮү]/);
  }
  assert.equal(calls.length, 5);
  assert.ok(calls.every(c => c.buyerId === buyerId));
  assert.deepEqual(calls.map(c => c.merchantId), DEMO_MERCHANTS.map(m => m.id));
});

test("authentication is checked before parsing requests or accessing merchant data", async () => {
  let processed = false;
  const denied = await result("invalid-json", {
    authenticate: async () => { throw new A2AAuthError(401, "secret-token-must-not-appear"); },
    processRFQ: async id => { processed = true; return responseFor(id); },
  });
  assert.equal(denied.response.status, 401);
  assert.equal(processed, false);
  assert.ok(denied.response.headers.get("WWW-Authenticate")?.startsWith("Bearer"));
  assert.ok(!JSON.stringify(denied.body).includes("secret-token"));
  assert.match(denied.body.error.message, /[А-Яа-яӨөҮү]/);
  assert.equal((await result(rpcBody(), { authenticate: async () => { throw new A2AAuthError(503, "missing-secret"); } })).response.status, 503);
});

test("merchant scopes from credentials and tenant fields cannot be replaced by client merchant IDs", async () => {
  let processed = false;
  const processRFQ = async (id: string) => { processed = true; return responseFor(id); };
  const denied = await result(rpcBody(), { processRFQ,
    authenticate: async () => ({ buyerId, allowedMerchantIds: ["demo-japan-used"] }) });
  assert.equal(denied.response.status, 403);
  const mismatched = await result(rpcBody("SendMessage", { ...rpcBody().params as object, tenant: "demo-japan-used" }), { processRFQ });
  assert.equal(mismatched.response.status, 403);
  assert.equal(processed, false);
  const forged = await result(rpcBody(), { processRFQ: async () => { throw new RFQInputError("scope_mismatch"); } });
  assert.equal(forged.response.status, 403);
});

test("invalid RFQs and conflicting RFQ IDs produce safe official invalid-params errors", async () => {
  for (const kind of ["invalid_rfq", "conflict"] as const) {
    const failure = await result(rpcBody(), { processRFQ: async () => { throw new RFQInputError(kind); } });
    assert.equal(failure.response.status, 200);
    assert.equal(failure.body.error.code, A2A_ERROR_CODE.INVALID_PARAMS);
    assert.equal(failure.body.id, "rpc-test");
    assert.match(failure.body.error.message, /[А-Яа-яӨөҮү]/);
  }
});

test("unexpected processor errors never return connection strings, credentials or SDK task errors", async () => {
  const failure = await result(rpcBody(), { processRFQ: async () => { throw new Error("mongodb+srv://username:password@cluster/?private-key=secret"); } });
  assert.equal(failure.body.error.code, A2A_ERROR_CODE.INTERNAL_ERROR);
  const text = JSON.stringify(failure.body);
  for (const value of ["mongodb", "password", "private-key", "secret", "task"]) assert.ok(!text.includes(value));
  assert.match(failure.body.error.message, /[А-Яа-яӨөҮү]/);
});

test("malformed JSON, invalid UTF-8, oversized bodies and invalid JSON-RPC structures fail safely", async () => {
  assert.equal((await result("{broken-json")).body.error.code, A2A_ERROR_CODE.PARSE_ERROR);
  const invalidUTF8 = new Request(`${origin}/api/a2a/${merchantId}`, { method: "POST", headers: {
    "content-type": "application/json", "A2A-Version": "1.0",
  }, body: new Uint8Array([0xc3, 0x28]) });
  const utf8 = await handleMerchantA2A(invalidUTF8, merchantId, dependencies());
  assert.equal((await utf8.json()).error.code, A2A_ERROR_CODE.PARSE_ERROR);
  assert.equal((await result(" ".repeat(65537))).body.error.code, A2A_ERROR_CODE.INVALID_REQUEST);
  assert.equal((await result([])).body.error.code, A2A_ERROR_CODE.INVALID_REQUEST);
  const invalidID = await result({ ...rpcBody(), id: { secret: "never-echo" } });
  assert.equal(invalidID.body.id, null);
  assert.ok(!JSON.stringify(invalidID.body).includes("never-echo"));
});

test("protocol version, content types and message shape are enforced before RFQ processing", async () => {
  let count = 0;
  const processRFQ = async (id: string) => { count++; return responseFor(id); };
  assert.equal((await result(rpcBody(), { processRFQ }, { "A2A-Version": "0.3" })).body.error.code, A2A_ERROR_CODE.VERSION_NOT_SUPPORTED);
  assert.equal((await result(rpcBody(), { processRFQ }, { "content-type": "text/plain" })).body.error.code, A2A_ERROR_CODE.CONTENT_TYPE_NOT_SUPPORTED);
  const malformed = [
    { messageId: "m", role: "ROLE_AGENT", parts: [{ data: envelope, mediaType: "application/json" }] },
    { messageId: "m", role: "ROLE_USER", parts: [{ text: "Үнийн санал", mediaType: "text/plain" }] },
    { messageId: "m", role: "ROLE_USER", parts: [{ data: envelope, mediaType: "image/png" }] },
    { messageId: "m", role: "ROLE_USER", parts: [{ data: envelope, text: "Хоёр төрөл", mediaType: "application/json" }] },
    { messageId: "m", role: "ROLE_USER", parts: [{ data: envelope, mediaType: "application/json" }, { data: {}, mediaType: "application/json" }] },
  ];
  for (const message of malformed) assert.ok((await result(rpcBody("SendMessage", { message }), { processRFQ })).body.error);
  assert.equal(count, 0);
  // The standard allows an omitted mediaType on structured data parts.
  assert.ok((await result(rpcBody("SendMessage", { message: {
    messageId: "optional-media-type", role: "ROLE_USER", parts: [{ data: envelope }],
  } }), { processRFQ })).body.result.message);
  assert.equal(count, 1);
});

test("unimplemented task, streaming, push and unknown methods return standard Mongolian SDK errors", async () => {
  const cases = [
    ["GetTask", A2A_ERROR_CODE.TASK_NOT_FOUND], ["CancelTask", A2A_ERROR_CODE.TASK_NOT_FOUND],
    ["ListTasks", A2A_ERROR_CODE.UNSUPPORTED_OPERATION], ["SendStreamingMessage", A2A_ERROR_CODE.UNSUPPORTED_OPERATION],
    ["SubscribeToTask", A2A_ERROR_CODE.UNSUPPORTED_OPERATION], ["GetExtendedAgentCard", A2A_ERROR_CODE.UNSUPPORTED_OPERATION],
    ["CreateTaskPushNotificationConfig", A2A_ERROR_CODE.PUSH_NOTIFICATION_NOT_SUPPORTED],
    ["invented/method", A2A_ERROR_CODE.METHOD_NOT_FOUND],
  ] as const;
  for (const [method, code] of cases) {
    const failure = await result(rpcBody(method, { id: "foreign-task" }));
    assert.equal(failure.body.error.code, code, method);
    assert.match(failure.body.error.message, /[А-Яа-яӨөҮү]/);
    assert.ok(!JSON.stringify(failure.body).includes("foreign-task"));
  }
  const followup = await result(rpcBody("SendMessage", {
    message: { messageId: "m", role: "ROLE_USER", taskId: "foreign-task", parts: [{ data: envelope, mediaType: "application/json" }] },
  }));
  assert.equal(followup.body.error.code, A2A_ERROR_CODE.UNSUPPORTED_OPERATION);
});

test("unknown merchant routes do not authenticate or reach processors", async () => {
  let touched = false;
  const response = await handleMerchantA2A(request(), "unknown-merchant", dependencies({
    authenticate: async () => { touched = true; throw new Error("Unexpected call"); },
    processRFQ: async id => { touched = true; return responseFor(id); },
  }));
  assert.equal(response.status, 404);
  assert.equal(touched, false);
});
