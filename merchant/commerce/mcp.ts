import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { getMerchantClient, getMerchantDb } from "../server/database";
import { authenticateMCP, MCPAuthError, type MCPPrincipal } from "./auth";
import { CommerceStore, CommerceStoreError } from "./store";
import { availabilityRequestSchema, approvalIntentRequestSchema } from "./contracts";
import { idSchema } from "../../shared/merchant-contracts";

const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
function service(store: CommerceStore, principal: MCPPrincipal) {
  const server = new McpServer({ name: "shamin-merchant-commerce", version: "1.0.0" }, { maxToolInputElements: 1000 });

  server.registerTool("check_availability", {
    title: "Бараа, засварын боломж шалгах",
    description: "Сонгосон үнийн саналын хувилбар, үнэ, сэлбэгийн үлдэгдэл болон засварын цагийг дахин шалгана.",
    inputSchema: availabilityRequestSchema,
  }, async ({ selections }) => result(await store.checkAvailability(selections, principal.buyerId, principal.merchantIds)));

  server.registerTool("request_user_approval", {
    title: "Худалдан авагчийн зөвшөөрөл хүсэх",
    description: "Яг батлах үнийн санал, хувилбар, нийт үнэ, засварын нөхцөлийг багтаасан зөвшөөрлийн холбоос үүсгэнэ. Хэрэглэгч өөрөө холбоосыг нээж батална.",
    inputSchema: approvalIntentRequestSchema,
  }, async input => result(await store.createApproval(input, principal.buyerId, principal.merchantIds)));

  const orderInput = z.strictObject({ transactionId: idSchema, approvalId: idSchema, idempotencyKey: idSchema });
  server.registerTool("create_parts_order", {
    title: "Сэлбэгийн захиалга үүсгэх",
    description: "Баталгаажсан хэрэглэгчийн зөвшөөрлийн дагуу нөөцийг атомикаар хасаж захиалга бүртгэнэ.",
    inputSchema: orderInput,
  }, async input => result(await store.createPartsOrder(input, principal.buyerId, principal.merchantIds)));

  const bookingInput = z.strictObject({ transactionId: idSchema, approvalId: idSchema, idempotencyKey: idSchema });
  server.registerTool("book_repair", {
    title: "Засварын цаг захиалах",
    description: "Зөвшөөрсөн яг ижил засварын цагийг давхар захиалахгүйгээр бүртгэнэ. Алдаа гарвал холбогдсон сэлбэгийн нөөцийг нөхөн олгоно.",
    inputSchema: bookingInput,
  }, async input => result(await store.bookRepair(input, principal.buyerId, principal.merchantIds)));

  server.registerTool("mock_payment", {
    title: "Туршилтын төлбөр бүртгэх",
    description: "Бодит төлбөрийн системд холбогдохгүйгээр амжилттай эсвэл бүтэлгүй туршилтын төлбөрийг бүртгэнэ.",
    inputSchema: z.strictObject({ transactionId: idSchema, approvalId: idSchema, idempotencyKey: idSchema,
      outcome: z.enum(["succeeded", "failed"]) }),
  }, async input => result(await store.mockPayment(input, principal.buyerId, principal.merchantIds)));

  server.registerTool("cancel_parts_order", {
    title: "Сэлбэгийн захиалга цуцлах",
    description: "Төлбөр баталгаажаагүй захиалгыг цуцалж нөөцийг нэг удаа буцаан нэмнэ.",
    inputSchema: z.strictObject({ transactionId: idSchema, approvalId: idSchema }),
  }, async input => result(await store.cancelPartsOrder(input.transactionId, input.approvalId, principal.buyerId, principal.merchantIds)));

  server.registerTool("cancel_repair_booking", {
    title: "Засварын цаг захиалга цуцлах",
    description: "Төлбөр баталгаажаагүй засварын захиалгыг цуцалж цагийн багтаамжийг нэг удаа буцаана.",
    inputSchema: z.strictObject({ transactionId: idSchema, approvalId: idSchema }),
  }, async input => result(await store.cancelRepairBooking(input.transactionId, input.approvalId, principal.buyerId, principal.merchantIds)));

  server.registerTool("cancel_transaction", {
    title: "Захиалгын гүйлгээг бүхэлд нь цуцлах",
    description: "Туршилтын төлбөр амжилттай болоогүй гүйлгээний сэлбэг болон засварын нөөцийг хамтад нь суллана.",
    inputSchema: z.strictObject({ transactionId: idSchema, approvalId: idSchema }),
  }, async input => result(await store.cancelTransaction(input.transactionId, input.approvalId, principal.buyerId, principal.merchantIds)));

  server.registerTool("get_transaction_status", {
    title: "Захиалгын явц харах",
    description: "Зөвхөн баталгаажсан Buyer Agent-ийн өөрийн гүйлгээ, захиалга, төлбөрийн туршилтын төлөвийг буцаана.",
    inputSchema: z.strictObject({ transactionId: idSchema }),
  }, async ({ transactionId }) => result(await store.getTransaction(transactionId, principal.buyerId, principal.merchantIds)));

  return server;
}

type MCPSession = {
  principal: MCPPrincipal;
  tokenHash: string;
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lastAccess: number;
};
const sessions = new Map<string, MCPSession>();
const sessionTokenHash = (request: Request) => createHash("sha256").update(request.headers.get("authorization") ?? "").digest("hex");
function samePrincipal(left: MCPPrincipal, right: MCPPrincipal): boolean {
  return left.buyerId === right.buyerId && left.demo === right.demo &&
    left.merchantIds.length === right.merchantIds.length && left.merchantIds.every(id => right.merchantIds.includes(id));
}

export async function handleCommerceMCP(request: Request): Promise<Response> {
  let principal: MCPPrincipal;
  try { principal = authenticateMCP(request); }
  catch (error) {
    const status = error instanceof MCPAuthError ? error.status : 401;
    return Response.json({ error: error instanceof MCPAuthError ? error.message : "MCP нэвтрэх эрхийг баталгаажуулна уу." },
      { status, headers: { "Cache-Control": "no-store", "WWW-Authenticate": 'Bearer realm="merchant-commerce"' } });
  }
  if (!["POST", "GET", "DELETE"].includes(request.method))
    return Response.json({ error: "MCP хүсэлтийн HTTP арга дэмжигдээгүй байна." }, { status: 405 });
  if (request.method === "POST" && request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    return Response.json({ error: "MCP хүсэлтийн JSON төрөл буруу байна." }, { status: 415 });
  try {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastAccess > 30 * 60_000) {
        sessions.delete(id);
        await session.server.close();
      }
    }
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session || !samePrincipal(session.principal, principal) || session.tokenHash !== sessionTokenHash(request))
        return Response.json({ error: "MCP сессийн хугацаа дууссан эсвэл эрх зөрж байна." }, { status: 404 });
      session.lastAccess = now;
      return await session.transport.handleRequest(request);
    }
    const approvalOrigin = process.env.MERCHANT_MCP_APPROVAL_ORIGIN;
    if (!approvalOrigin) throw new CommerceStoreError("invalid");
    const store = new CommerceStore(await getMerchantClient(), await getMerchantDb(), approvalOrigin);
    const server = service(store, principal);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID, enableJsonResponse: true, maxRequestBodySize: 65536,
      allowedHosts: process.env.MERCHANT_MCP_ALLOWED_HOSTS?.split(",").filter(Boolean),
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    if (transport.sessionId)
      sessions.set(transport.sessionId, { principal, tokenHash: sessionTokenHash(request), server, transport, lastAccess: Date.now() });
    return response;
  } catch (error) {
    const status = error instanceof CommerceStoreError ? (error.code === "unauthorized" ? 403 : 400) : 503;
    return Response.json({ error: error instanceof CommerceStoreError ? error.message :
      "MCP худалдааны хүсэлтийг боловсруулах боломжгүй байна." },
    { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
}
