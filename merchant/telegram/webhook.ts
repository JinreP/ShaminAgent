import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { Db } from "mongodb";
import type { TelegramConfig } from "./config";
import { telegramUpdateSchema } from "./contracts";
import { withTelegramWebhookLease, TelegramTransportConflict, type TelegramRuntime } from "./worker";

const MAX_BODY_BYTES = 65536;
export function validateWebhookSecret(supplied: string | null, expected: string): boolean {
  if (!supplied || supplied.length > 256) return false;
  const left = Buffer.from(supplied), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
async function readBoundedBody(request: Request): Promise<string> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new RangeError();
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new RangeError(); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Authenticate before establishing database/provider connections. */
export function validateWebhookRequest(request: Request, config: TelegramConfig): Response | undefined {
  if (config.mode !== "webhook" || !config.webhookSecret || !config.webhookUrl) {
    return Response.json({ error: "Телеграмын HTTPS хүлээн авагч идэвхгүй байна." }, { status: 503 });
  }
  // TLS can terminate at the deployment proxy. That proxy must replace this header, never append untrusted client values.
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  if (!secure) return Response.json({ error: "HTTPS холболт шаардлагатай." }, { status: 400 });
  if (!validateWebhookSecret(request.headers.get("x-telegram-bot-api-secret-token"), config.webhookSecret)) {
    return Response.json({ error: "Хүсэлтийн эрхийг баталгаажуулж чадсангүй." }, { status: 401 });
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "Хүсэлтийн өгөгдлийн төрөл буруу байна." }, { status: 415 });
  }
}

export async function handleTelegramWebhook(request: Request, dependencies: {
  config: TelegramConfig; db: Db; runtime: TelegramRuntime;
}): Promise<Response> {
  const { config, db, runtime } = dependencies;
  const invalid = validateWebhookRequest(request, config);
  if (invalid) return invalid;
  let body: unknown;
  try { body = JSON.parse(await readBoundedBody(request)); }
  catch (error) { return Response.json({ error: "Хүсэлтийн өгөгдөл буруу байна." }, { status: error instanceof RangeError ? 413 : 400 }); }
  const update = telegramUpdateSchema.safeParse(body);
  if (!update.success) return Response.json({ error: "Телеграмын хүсэлтийн бүтэц буруу байна." }, { status: 400 });
  try {
    await withTelegramWebhookLease(db, config, () => runtime.processUpdate(update.data));
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof TelegramTransportConflict ? error.message : "Хүсэлтийг боловсруулж чадсангүй. Дахин илгээнэ үү." },
      { status: error instanceof TelegramTransportConflict ? 409 : 503 });
  }
}
