import "server-only";
import { randomUUID } from "node:crypto";
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { SendMessageRequest } from "@a2a-js/sdk";
import { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { idSchema } from "../shared/merchant-contracts";
import { merchantRFQResponseSchema } from "../merchant/a2a/contracts";
import { negotiationResponseSchema, type NegotiationRequest } from "../merchant/negotiation/contracts";
import { buildRFQ, combineOffers, type BuyerGoal } from "./buyer-merchant-domain";

export class BuyerMerchantError extends Error {}
export type CommerceCall = <T>(name: string, input: Record<string, unknown>, schema: z.ZodType<T>) => Promise<T>;
export interface BuyerMerchantGateway {
  buyerId: string;
  origin: string;
  quoteBatch(goal: BuyerGoal, batchId: string): Promise<{ quotes: ReturnType<typeof combineOffers>; issues: string[] }>;
  negotiate(input: NegotiationRequest): Promise<z.infer<typeof negotiationResponseSchema>>;
  negotiationResult(input: NegotiationRequest): Promise<z.infer<typeof negotiationResponseSchema>>;
  commerce<T>(work: (call: CommerceCall) => Promise<T>): Promise<T>;
}

const directorySchema = z.object({
  contractVersion: z.literal("1"), mode: z.literal("simulated"),
  merchants: z.array(z.object({ merchantId: idSchema, name: z.string(), kind: z.enum(["parts", "repair"]),
    agentCardUrl: z.string().url(), a2aUrl: z.string().url() })).max(20),
});

export function createBuyerMerchantGateway(source: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch): BuyerMerchantGateway {
  // The existing approval-link provider is loopback/demo-only. Do not silently
  // deploy this service identity as authentication for production end users.
  const origin = new URL(source.BUYER_MERCHANT_ORIGIN ?? "http://localhost:3000");
  if (source.NODE_ENV === "production" || !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
      origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash ||
      !["http:", "https:"].includes(origin.protocol)) {
    throw new BuyerMerchantError("Buyer–Merchant demo холболтыг локал хөгжүүлэлтийн орчинд ажиллуулна уу.");
  }
  const buyerId = idSchema.safeParse(source.BUYER_MERCHANT_BUYER_ID ?? source.MERCHANT_A2A_DEMO_BUYER_ID);
  const a2aToken = source.BUYER_MERCHANT_A2A_TOKEN ?? source.MERCHANT_A2A_DEMO_TOKEN;
  const mcpToken = source.BUYER_MERCHANT_MCP_TOKEN ?? source.MERCHANT_MCP_TOKEN;
  if (!buyerId.success || !a2aToken || a2aToken.length < 32 || !mcpToken || mcpToken.length < 32 ||
      (source.MERCHANT_MCP_BUYER_ID && source.MERCHANT_MCP_BUYER_ID !== buyerId.data)) {
    throw new BuyerMerchantError("Buyer–Merchant token болон buyer ID тохиргоог шалгана уу.");
  }
  const originURL = origin.origin;
  function scopedFetch(token: string): typeof fetch {
    return (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== originURL || !url.pathname.startsWith("/api/")) {
        throw new BuyerMerchantError("Merchant хаягийн хүрээ тохирохгүй байна.");
      }
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set("Authorization", `Bearer ${token}`);
      const signal = init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000);
      return fetchImpl(input, { ...init, headers, signal, redirect: "error", cache: "no-store" });
    };
  }
  const a2aFetch = scopedFetch(a2aToken), mcpFetch = scopedFetch(mcpToken);

  async function send(merchantId: string, data: unknown) {
    const client = await new ClientFactory({ cardResolver: new DefaultAgentCardResolver({ fetchImpl: a2aFetch }), transports: [new JsonRpcTransportFactory({ fetchImpl: a2aFetch })] })
      .createFromUrl(`${originURL}/api/a2a/${encodeURIComponent(merchantId)}/.well-known/agent-card.json`, "");
    const response = await client.sendMessage(SendMessageRequest.fromJSON({
      message: { messageId: randomUUID(), role: "ROLE_USER", parts: [{ mediaType: "application/json", data }] },
    }));
    if (!("parts" in response) || response.parts[0]?.content?.$case !== "data") {
      throw new BuyerMerchantError("Merchant-ийн бүтэцтэй хариулт ирсэнгүй.");
    }
    return response.parts[0].content.value;
  }

  async function checkedNegotiation(input: NegotiationRequest, poll: boolean) {
    const response = negotiationResponseSchema.parse(await send(input.negotiation.merchantId, poll
      ? { contractVersion: "1", action: "get_negotiation_result", rfqId: input.rfqId, negotiationId: input.negotiation.id }
      : input));
    if (response.merchantId !== input.negotiation.merchantId || response.rfqId !== input.rfqId ||
        response.correlationId !== input.correlationId || response.negotiationId !== input.negotiation.id ||
        response.negotiation.buyerId !== buyerId.data) throw new BuyerMerchantError("Merchant хэлэлцээний хүрээ тохирохгүй байна.");
    return response;
  }

  return {
    buyerId: buyerId.data, origin: originURL,
    async quoteBatch(goal, batchId) {
      const response = await a2aFetch(`${originURL}/api/a2a/discovery`);
      if (!response.ok) throw new BuyerMerchantError("Merchant жагсаалтыг авах боломжгүй байна.");
      const directory = directorySchema.parse(await response.json());
      const names = Object.fromEntries(directory.merchants.map(item => [item.merchantId, item.name]));
      const results = await Promise.allSettled(directory.merchants.map(async merchant => {
        const expected = `${originURL}/api/a2a/${merchant.merchantId}`;
        if (merchant.a2aUrl !== expected || merchant.agentCardUrl !== `${expected}/.well-known/agent-card.json`) {
          throw new BuyerMerchantError("Merchant discovery хаяг тохирохгүй байна.");
        }
        const envelope = buildRFQ(goal, merchant.merchantId, merchant.kind, buyerId.data, batchId);
        const value = merchantRFQResponseSchema.parse(await send(merchant.merchantId, envelope));
        if (value.merchantId !== merchant.merchantId || value.rfqId !== envelope.rfq.id ||
            value.correlationId !== envelope.correlationId || (value.quote &&
            (value.quote.merchantId !== merchant.merchantId || value.quote.rfqId !== envelope.rfq.id || value.quote.buyerId !== buyerId.data || value.quote.kind !== merchant.kind || value.quote.mode !== "simulated"))) {
          throw new BuyerMerchantError("Merchant саналын хүрээ тохирохгүй байна.");
        }
        return value;
      }));
      const values = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      const issues = results.flatMap((result, index) => result.status === "rejected"
        ? [`${directory.merchants[index].name}: холболт эсвэл саналын формат буруу.`]
        : result.value.outcome !== "quoted" ? [`${names[result.value.merchantId]}: ${result.value.message}`] : []);
      return { quotes: combineOffers(goal, values, names), issues };
    },
    negotiate: input => checkedNegotiation(input, false),
    negotiationResult: input => checkedNegotiation(input, true),
    async commerce(work) {
      const client = new MCPClient({ name: "shamin-buyer", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${originURL}/api/mcp/commerce`), { fetch: mcpFetch });
      try {
        await client.connect(transport);
        const listed = await client.listTools();
        const names = new Set(listed.tools.map(tool => tool.name));
        return await work(async (name, input, schema) => {
          if (!names.has(name)) throw new BuyerMerchantError("Merchant MCP үйлдэл олдсонгүй.");
          const response = await client.callTool({ name, arguments: input }, undefined, { timeout: 20_000 });
          if (response.isError) throw new BuyerMerchantError("Merchant захиалгын үйлдлийг зөвшөөрсөнгүй. Үнийн хувилбар, нөөц, зөвшөөрлийн хугацаагаа шалгаарай.");
          const parsed = z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }).parse(response);
          const part = parsed.content.find(item => item.type === "text");
          if (!part || part.type !== "text" || !part.text) throw new BuyerMerchantError("Merchant MCP хариултын формат буруу.");
          return schema.parse(JSON.parse(part.text));
        });
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}
