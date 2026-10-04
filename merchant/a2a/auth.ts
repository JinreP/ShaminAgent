import "server-only";
import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { idSchema } from "../../shared/merchant-contracts";
import { DEMO_MERCHANTS } from "../demo-merchants";

type Env = Record<string, string | undefined>;
export type A2APrincipal = { buyerId: string; allowedMerchantIds: string[] };
export class A2AAuthError extends Error {
  constructor(public readonly status: 401 | 403 | 503, message: string) { super(message); }
}
function validOrigin(value: string, production: boolean): string {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
        !["http:", "https:"].includes(url.protocol) || (production && url.protocol !== "https:")) throw new Error();
    return url.origin;
  } catch { throw new A2AAuthError(503, "Агентын нийтийн хаягийн тохиргоо буруу байна."); }
}
export function getA2AConfig(source: Env = process.env) {
  const production = source.NODE_ENV === "production";
  return {
    origin: validOrigin(source.MERCHANT_A2A_ORIGIN ?? (production ? "" : "http://localhost:3000"), production),
    authMode: source.MERCHANT_A2A_AUTH_MODE ?? "disabled",
  };
}
const remoteKeys = new Map<string, JWTVerifyGetKey>();
function denied(): A2AAuthError { return new A2AAuthError(401, "Нэвтрэх токен хүчингүй эсвэл хугацаа дууссан байна."); }
/** Signed buyer_id and merchant_ids are supplied by the production identity service, never by the RFQ. */
export async function authenticateA2A(request: Request, merchantId: string, source: Env = process.env,
  keyResolver?: JWTVerifyGetKey): Promise<A2APrincipal> {
  if (!DEMO_MERCHANTS.some(m => m.id === merchantId)) throw new A2AAuthError(403, "Энэ худалдаачинд хандах эрхгүй байна.");
  const config = getA2AConfig(source);
  const header = request.headers.get("authorization") ?? "";
  if (header.length > 16384 || !/^Bearer [^\s]+$/i.test(header)) throw denied();
  const token = header.slice(7);
  let principal: A2APrincipal;
  if (config.authMode === "demo") {
    const origin = new URL(config.origin);
    const requestURL = new URL(request.url);
    if (source.NODE_ENV === "production" || source.MERCHANT_A2A_DEMO_ENABLED !== "true" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) || requestURL.origin !== config.origin)
      throw new A2AAuthError(503, "Туршилтын агентын нэвтрэлт зөвхөн локал хөгжүүлэлтийн орчинд боломжтой.");
    const expected = source.MERCHANT_A2A_DEMO_TOKEN;
    const buyer = idSchema.safeParse(source.MERCHANT_A2A_DEMO_BUYER_ID);
    if (!expected || expected.length < 32 || !buyer.success)
      throw new A2AAuthError(503, "Туршилтын агентын нэвтрэх тохиргоо дутуу байна.");
    const providedBytes = Buffer.from(token), expectedBytes = Buffer.from(expected);
    if (providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) throw denied();
    principal = { buyerId: buyer.data, allowedMerchantIds: DEMO_MERCHANTS.map(m => m.id) };
  } else if (config.authMode === "jwt") {
    const uri = source.MERCHANT_A2A_JWKS_URI, issuer = source.MERCHANT_A2A_ISSUER, audience = source.MERCHANT_A2A_AUDIENCE;
    let jwksURL: URL;
    try {
      jwksURL = new URL(uri ?? "");
      if (jwksURL.protocol !== "https:" || jwksURL.username || jwksURL.password || !issuer || !audience) throw new Error();
    } catch { throw new A2AAuthError(503, "Агентын баталгаажуулалтын тохиргоо дутуу байна."); }
    let keys = keyResolver ?? remoteKeys.get(jwksURL.href);
    if (!keys) { keys = createRemoteJWKSet(jwksURL); remoteKeys.set(jwksURL.href, keys); }
    try {
      const { payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ["RS256", "ES256"],
        requiredClaims: ["exp", "sub", "buyer_id", "merchant_ids"], maxTokenAge: "1h" });
      const buyer = idSchema.parse(payload.buyer_id);
      if (!Array.isArray(payload.merchant_ids) || payload.merchant_ids.length === 0 || payload.merchant_ids.length > 100) throw denied();
      const merchants = payload.merchant_ids.map(id => idSchema.parse(id));
      principal = { buyerId: buyer, allowedMerchantIds: merchants };
    } catch { throw denied(); }
  } else throw new A2AAuthError(503, "Агентын нэвтрэлт тохируулагдаагүй байна.");
  if (!principal.allowedMerchantIds.includes(merchantId)) throw new A2AAuthError(403, "Энэ худалдаачинд хандах эрхгүй байна.");
  return principal;
}
