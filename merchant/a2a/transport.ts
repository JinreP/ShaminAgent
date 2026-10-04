import "server-only";
import { Message, Role, type SendMessageRequest, type StreamResponse, type Task, type ListTasksResponse } from "@a2a-js/sdk";
import {
  AgentEvent, DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler, ServerCallContext,
  validateVersion, type AgentExecutor, type ExecutionEventBus, type RequestContext,
} from "@a2a-js/sdk/server";
import {
  A2AError, A2A_ERROR_CODE, ContentTypeNotSupportedError, JsonRpcRequestMalformedError, JsonRpcTransportError,
  PushNotificationNotSupportedError, RequestMalformedError, TaskNotFoundError,
  UnsupportedOperationError, toJsonRpcError,
} from "@a2a-js/sdk/errors";
import { authenticateA2A, getA2AConfig } from "./auth";
import { getMerchantAgentCard, isA2AMerchant } from "./cards";
import type { MerchantRFQResponse } from "./contracts";
import { processMerchantRFQ, RFQInputError } from "./service";

export type A2APrincipal = { buyerId: string; allowedMerchantIds: string[] };
export type MerchantA2ADependencies = {
  authenticate?: (request: Request, merchantId: string) => Promise<A2APrincipal>;
  processRFQ?: (merchantId: string, buyerId: string, input: unknown) => Promise<MerchantRFQResponse>;
  origin?: string;
};

const MAX_REQUEST_BYTES = 65536;
const errorMessages: Record<number, string> = {
  [A2A_ERROR_CODE.PARSE_ERROR]: "Хүсэлтийн JSON өгөгдөл буруу байна.",
  [A2A_ERROR_CODE.INVALID_REQUEST]: "A2A хүсэлтийн бүтэц буруу байна.",
  [A2A_ERROR_CODE.METHOD_NOT_FOUND]: "A2A үйлдэл олдсонгүй.",
  [A2A_ERROR_CODE.INVALID_PARAMS]: "Хүсэлтийн талбарууд буруу байна.",
  [A2A_ERROR_CODE.INTERNAL_ERROR]: "Хүсэлтийг боловсруулахад алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу.",
  [A2A_ERROR_CODE.TASK_NOT_FOUND]: "Даалгавар олдсонгүй. Энэ агент үнийн саналыг шууд хариулдаг.",
  [A2A_ERROR_CODE.TASK_NOT_CANCELABLE]: "Даалгаврыг цуцлах боломжгүй.",
  [A2A_ERROR_CODE.PUSH_NOTIFICATION_NOT_SUPPORTED]: "Мэдэгдэл түлхэх боломж дэмжигдээгүй.",
  [A2A_ERROR_CODE.UNSUPPORTED_OPERATION]: "Энэ үйлдэл дэмжигдээгүй. Үнийн саналын хүсэлт илгээнэ үү.",
  [A2A_ERROR_CODE.CONTENT_TYPE_NOT_SUPPORTED]: "Хүсэлтийг application/json бүтэцтэй өгөгдлөөр илгээнэ үү.",
  [A2A_ERROR_CODE.INVALID_AGENT_RESPONSE]: "Агентийн хариултын бүтэц буруу байна.",
  [A2A_ERROR_CODE.EXTENDED_CARD_NOT_CONFIGURED]: "Өргөтгөсөн агентын карт тохируулагдаагүй.",
  [A2A_ERROR_CODE.EXTENSION_SUPPORT_REQUIRED]: "Хүсэлтэд шаардлагатай протоколын өргөтгөл дутуу байна.",
  [A2A_ERROR_CODE.VERSION_NOT_SUPPORTED]: "A2A протоколын хувилбар дэмжигдээгүй. A2A-Version: 1.0 толгой ашиглана уу.",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "A2A-Version": "1.0", ...headers,
  } });
}

function rpcFailure(error: unknown, id: string | number | null = null): Response {
  const mapped = toJsonRpcError(error);
  // The SDK can include input values or English prose in errors. Return only
  // its official error code and a fixed Mongolian message, never raw errors.
  return json({ jsonrpc: "2.0", id, error: { code: mapped.code, message: errorMessages[mapped.code] ?? errorMessages[A2A_ERROR_CODE.INTERNAL_ERROR] } });
}

async function readBoundedBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new JsonRpcRequestMalformedError({ envelopeCode: A2A_ERROR_CODE.INVALID_REQUEST, message: "Хүсэлт хэт том байна." });
    }
    chunks.push(value);
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new JsonRpcTransportError({ jsonrpc: "2.0", id: null, error: { code: A2A_ERROR_CODE.PARSE_ERROR, message: "JSON кодчилол буруу байна." } }); }
}

function validateMessage(params: SendMessageRequest): void {
  const message = params.message;
  if (!message || message.role !== Role.ROLE_USER || !message.messageId || message.messageId.length > 128)
    throw new RequestMalformedError("Худалдан авагчийн мессеж шаардлагатай.");
  if (message.taskId || message.referenceTaskIds.length)
    throw new UnsupportedOperationError("Энэ агент даалгавар үүсгэхгүй.");
  if (message.parts.length !== 1 || message.parts[0]?.content?.$case !== "data")
    throw new ContentTypeNotSupportedError("Нэг бүтэцтэй JSON хүсэлт шаардлагатай.");
  // A2A v1.0 makes Part.mediaType optional; a data part without it is JSON.
  if (message.parts[0].mediaType && message.parts[0].mediaType !== "application/json")
    throw new ContentTypeNotSupportedError("JSON өгөгдлийн төрөл шаардлагатай.");
  if (params.configuration?.taskPushNotificationConfig)
    throw new PushNotificationNotSupportedError("Мэдэгдэл түлхэх боломж дэмжигдээгүй.");
  if (params.configuration?.acceptedOutputModes.length && !params.configuration.acceptedOutputModes.includes("application/json"))
    throw new ContentTypeNotSupportedError("JSON хариултын төрөл шаардлагатай.");
}

// These agents return immediate Messages. Durable RFQ/quote processing is in
// the existing MongoDB infrastructure; A2A task APIs are deliberately disabled.
class ImmediateMerchantHandler extends DefaultRequestHandler {
  constructor(card: ReturnType<typeof getMerchantAgentCard>, executor: AgentExecutor, private readonly failure: () => unknown) {
    // This store is request-local and receives no Task events. It cannot retain
    // another buyer's messages, nor imply durable task support.
    super(card, new InMemoryTaskStore(), executor);
  }
  override async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Message | Task> {
    validateMessage(params);
    const result = await super.sendMessage(params, context);
    const error = this.failure();
    if (error instanceof RFQInputError && error.kind !== "scope_mismatch")
      throw new JsonRpcRequestMalformedError({ envelopeCode: A2A_ERROR_CODE.INVALID_PARAMS, message: "Үнийн саналын хүсэлт буруу эсвэл давхардсан дугаарын өгөгдөл зөрж байна." });
    if (error) throw new A2AError("Үнийн санал боловсруулахад алдаа гарлаа.");
    return result;
  }
  override async getTask(): Promise<Task> { throw new TaskNotFoundError("Даалгавар олдсонгүй."); }
  override async listTasks(): Promise<ListTasksResponse> { throw new UnsupportedOperationError("Даалгаврын жагсаалт дэмжигдээгүй."); }
  override async cancelTask(): Promise<Task> { throw new TaskNotFoundError("Даалгавар олдсонгүй."); }
  override async *sendMessageStream(): AsyncGenerator<StreamResponse, void, undefined> { throw new UnsupportedOperationError("Урсгал хариулт дэмжигдээгүй."); }
  override async *resubscribe(): AsyncGenerator<StreamResponse, void, undefined> { throw new UnsupportedOperationError("Даалгаврын урсгал дэмжигдээгүй."); }
  override async createTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError("Мэдэгдэл дэмжигдээгүй."); }
  override async getTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError("Мэдэгдэл дэмжигдээгүй."); }
  override async listTaskPushNotificationConfigs(): Promise<never> { throw new PushNotificationNotSupportedError("Мэдэгдэл дэмжигдээгүй."); }
  override async deleteTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError("Мэдэгдэл дэмжигдээгүй."); }
}

// Dependency injection is an isolated Buyer test seam. Application routes never
// accept these dependencies from request parameters or client data.
export async function handleMerchantA2A(request: Request, merchantId: string, dependencies: MerchantA2ADependencies = {}): Promise<Response> {
  if (!isA2AMerchant(merchantId)) return json({ error: { code: "merchant_not_found", message: "Худалдаачин олдсонгүй." } }, 404);
  let principal: A2APrincipal;
  try {
    principal = await (dependencies.authenticate ?? authenticateA2A)(request, merchantId);
    if (!principal.allowedMerchantIds.includes(merchantId))
      return json({ error: { code: "forbidden", message: "Энэ худалдаачинд хандах эрхгүй байна." } }, 403);
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error && (error.status === 403 || error.status === 503) ? error.status : 401;
    const message = status === 503 ? "A2A нэвтрэлт тохируулагдаагүй байна." : status === 403 ? "Энэ худалдаачинд хандах эрхгүй байна." : "Нэвтрэх эрхээ баталгаажуулна уу.";
    return json({ error: { code: status === 503 ? "authentication_unavailable" : status === 403 ? "forbidden" : "unauthenticated", message } }, status,
      status === 401 ? { "WWW-Authenticate": 'Bearer realm="merchant-a2a"' } : {});
  }

  let requestId: string | number | null = null;
  try {
    const card = getMerchantAgentCard(merchantId, dependencies.origin ?? getA2AConfig().origin);
    const version = request.headers.get("A2A-Version") ?? "0.3";
    validateVersion(version, card, "JSONRPC");
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
      throw new ContentTypeNotSupportedError("JSON хүсэлт шаардлагатай.");
    const text = await readBoundedBody(request);
    let body: unknown;
    try { body = JSON.parse(text) as unknown; }
    catch { throw new JsonRpcTransportError({ jsonrpc: "2.0", id: null, error: { code: A2A_ERROR_CODE.PARSE_ERROR, message: "JSON бүтэц буруу байна." } }); }
    if (body && typeof body === "object" && "id" in body && (typeof body.id === "string" || (typeof body.id === "number" && Number.isInteger(body.id)))) requestId = body.id;
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new JsonRpcRequestMalformedError({ envelopeCode: A2A_ERROR_CODE.INVALID_REQUEST, message: "A2A хүсэлт шаардлагатай." });
    const params = "params" in body && body.params && typeof body.params === "object" ? body.params : undefined;
    if (params && "tenant" in params && params.tenant && params.tenant !== merchantId)
      return json({ error: { code: "forbidden", message: "Хүсэлтийн худалдаачны хүрээ зөрж байна." } }, 403);
    if ("method" in body && body.method === "SendMessage" && params && "message" in params && params.message && typeof params.message === "object") {
      const message = params.message;
      if ("parts" in message && Array.isArray(message.parts) && message.parts.some(part =>
        !part || typeof part !== "object" || ["data", "text", "raw", "url"].filter(key => key in part).length !== 1))
        throw new JsonRpcRequestMalformedError({ envelopeCode: A2A_ERROR_CODE.INVALID_PARAMS, message: "Мессежийн хэсэг нэг төрлийн өгөгдөл агуулсан байх ёстой." });
    }

    let executionFailure: unknown;
    const executor: AgentExecutor = {
      async execute(context: RequestContext, eventBus: ExecutionEventBus) {
        let response: MerchantRFQResponse | undefined;
        try {
          const part = context.userMessage.parts[0];
          response = await (dependencies.processRFQ ?? processMerchantRFQ)(merchantId, principal.buyerId, part.content?.value);
        } catch (error) {
          executionFailure = error instanceof RFQInputError ? error : new A2AError("Үнийн санал боловсруулахад алдаа гарлаа.");
        }
        // An unexpected failure publishes only a safe message to let the SDK
        // settle its event queue, then sendMessage maps it to an internal error.
        const message = Message.fromJSON({
          messageId: crypto.randomUUID(), contextId: context.contextId, role: "ROLE_AGENT",
          parts: response === undefined
            ? [{ text: errorMessages[A2A_ERROR_CODE.INTERNAL_ERROR], mediaType: "text/plain" }]
            : [{ data: response, mediaType: "application/json" }],
        });
        eventBus.publish(AgentEvent.message(message));
      },
      async cancelTask() { throw new TaskNotFoundError("Даалгавар олдсонгүй."); },
    };
    const handler = new ImmediateMerchantHandler(card, executor, () => executionFailure);
    const context = new ServerCallContext({ requestedVersion: version,
      user: { isAuthenticated: true, userName: principal.buyerId } });
    const result = await new JsonRpcTransportHandler(handler).handle(body as Record<string, unknown>, context);
    if (executionFailure instanceof RFQInputError && executionFailure.kind === "scope_mismatch")
      return json({ error: { code: "forbidden", message: "Хүсэлтийн худалдан авагч эсвэл худалдаачны хүрээ зөрж байна." } }, 403);
    if (Symbol.asyncIterator in result) {
      // Streaming is never advertised. Consume the SDK stream's first error so
      // unsupported streaming calls still get the official protocol envelope.
      try { await result.next(); } catch (error) { return rpcFailure(error, requestId); }
      return rpcFailure(new UnsupportedOperationError("Урсгал хариулт дэмжигдээгүй."), requestId);
    }
    if (result.error && typeof result.error === "object" && "code" in result.error && typeof result.error.code === "number") {
      return json({ jsonrpc: "2.0", id: requestId, error: { code: result.error.code, message: errorMessages[result.error.code] ?? errorMessages[A2A_ERROR_CODE.INTERNAL_ERROR] } });
    }
    return json(result);
  } catch (error) { return rpcFailure(error, requestId); }
}
