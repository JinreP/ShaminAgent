import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { DEMO_MERCHANTS } from "../demo-merchants";
export { DEMO_MERCHANTS } from "../demo-merchants";
export const DEMO_COOKIE = "zahagent_merchant_demo";
export const DEMO_TTL_SECONDS = 3600;
export class MerchantAccessError extends Error {
  constructor(message = "Merchant demo access denied", public readonly status = 401) { super(message); }
}
export function demoConfig(source: Record<string, string | undefined> = process.env) {
  if (source.NODE_ENV === "production" || source.MERCHANT_DEMO_ENABLED !== "true")
    throw new MerchantAccessError("Merchant demo is disabled; production authentication is not implemented", 403);
  const secret = source.MERCHANT_DEMO_SESSION_SECRET;
  const accessKey = source.MERCHANT_DEMO_ACCESS_KEY;
  const origin = source.MERCHANT_DEMO_ORIGIN;
  const invalid = [
    ...(!origin ? ["MERCHANT_DEMO_ORIGIN"] : []),
    ...(!accessKey || accessKey.length < 32 ? ["MERCHANT_DEMO_ACCESS_KEY"] : []),
    ...(!secret || secret.length < 32 ? ["MERCHANT_DEMO_SESSION_SECRET"] : []),
  ];
  if (!secret || !accessKey || !origin || invalid.length)
    throw new MerchantAccessError(`Merchant demo configuration is incomplete: ${invalid.join(", ")}`, 503);
  let url: URL;
  try { url = new URL(origin); } catch { throw new MerchantAccessError("Invalid demo origin", 503); }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.origin !== origin)
    throw new MerchantAccessError("Demo origin must be a loopback origin", 503);
  return { secret, accessKey, origin };
}
export function requireDemoOrigin(request: Request, config: ReturnType<typeof demoConfig>) {
  if (request.headers.get("origin") !== config.origin || new URL(request.url).origin !== config.origin)
    throw new MerchantAccessError("Invalid request origin", 403);
}
function sameSecret(left: string, right: string) {
  // Hash before timing comparison to normalize variable-length inputs.
  const digest = (s: string) => createHmac("sha256", "zahagent-compare").update(s).digest();
  return timingSafeEqual(digest(left), digest(right));
}
export function verifyDemoKey(key: string, config: ReturnType<typeof demoConfig>) {
  if (!sameSecret(key, config.accessKey)) throw new MerchantAccessError();
}
export function assertDemoMerchant(id: string) {
  if (!DEMO_MERCHANTS.some(m => m.id === id)) throw new MerchantAccessError("Unknown simulated merchant", 403);
}
const sessionSchema = z.strictObject({ merchantId: z.string(), expiresAt: z.number().int() });
export function issueDemoSession(merchantId: string, config: ReturnType<typeof demoConfig>, now = Date.now()) {
  assertDemoMerchant(merchantId);
  const payload = Buffer.from(JSON.stringify({ merchantId, expiresAt: now + DEMO_TTL_SECONDS * 1000 })).toString("base64url");
  return `${payload}.${createHmac("sha256", config.secret).update(payload).digest("base64url")}`;
}
export function verifyDemoSession(token: string | undefined, config: ReturnType<typeof demoConfig>, now = Date.now()) {
  if (!token || token.length > 2048) throw new MerchantAccessError();
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined || !sameSecret(signature, createHmac("sha256", config.secret).update(payload).digest("base64url")))
    throw new MerchantAccessError();
  try {
    const session = sessionSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
    if (session.expiresAt <= now || session.expiresAt > now + DEMO_TTL_SECONDS * 1000) throw new MerchantAccessError();
    assertDemoMerchant(session.merchantId);
    return session.merchantId;
  } catch { throw new MerchantAccessError(); }
}
