import "server-only";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DEMO_MERCHANTS } from "../demo-merchants";
import { idSchema } from "../../shared/merchant-contracts";

const merchantListSchema = z.array(idSchema).min(1).max(100);
export type MCPPrincipal = { buyerId: string; merchantIds: string[]; demo: boolean };
export class MCPAuthError extends Error {
  constructor(readonly status: 401 | 403 | 503, message: string) { super(message); }
}
function equalSecret(supplied: string, expected: string): boolean {
  const left = Buffer.from(supplied), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function authenticateMCP(request: Request, source: Record<string, string | undefined> = process.env): MCPPrincipal {
  if (source.MERCHANT_MCP_ENABLED !== "true") throw new MCPAuthError(503, "MCP худалдааны үйлчилгээ идэвхгүй байна.");
  const header = request.headers.get("authorization") ?? "";
  if (header.length > 8192 || !/^Bearer [A-Za-z0-9._~-]{32,4096}$/.test(header))
    throw new MCPAuthError(401, "MCP нэвтрэх эрхийг баталгаажуулна уу.");
  const token = header.slice(7), expected = source.MERCHANT_MCP_TOKEN;
  const buyer = idSchema.safeParse(source.MERCHANT_MCP_BUYER_ID);
  const merchants = merchantListSchema.safeParse((source.MERCHANT_MCP_MERCHANT_IDS ?? "").split(",").filter(Boolean));
  if (!expected || expected.length < 32 || !buyer.success || !merchants.success ||
      merchants.data.some(id => !DEMO_MERCHANTS.some(merchant => merchant.id === id))) {
    throw new MCPAuthError(503, "MCP нэвтрэлт эсвэл худалдаачны хүрээний тохиргоо дутуу байна.");
  }
  const demo = source.MERCHANT_MCP_AUTH_MODE === "demo";
  if (source.MERCHANT_MCP_AUTH_MODE !== "demo" && source.MERCHANT_MCP_AUTH_MODE !== "token")
    throw new MCPAuthError(503, "MCP нэвтрэх горим буруу байна.");
  if (demo && (source.NODE_ENV === "production" || source.MERCHANT_MCP_DEMO_ENABLED !== "true" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname))) {
    throw new MCPAuthError(503, "Туршилтын MCP нэвтрэлт зөвхөн локал хөгжүүлэлтийн орчинд боломжтой.");
  }
  if (!equalSecret(token, expected)) throw new MCPAuthError(401, "MCP нэвтрэх эрхийг баталгаажуулна уу.");
  return { buyerId: buyer.data, merchantIds: merchants.data, demo };
}
