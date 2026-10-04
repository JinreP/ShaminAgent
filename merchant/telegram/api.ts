import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { telegramUpdateSchema, type TelegramUpdate } from "./contracts";

export type InlineKeyboard = { inline_keyboard: { text: string; callback_data: string }[][] };
export interface TelegramAPI {
  getMe(): Promise<{ id: number; is_bot: boolean; username?: string }>;
  deleteWebhook(): Promise<void>;
  setWebhook(url: string, secret: string): Promise<void>;
  getUpdates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string, text: string, buttons?: InlineKeyboard): Promise<{ message_id: number }>;
  answerCallbackQuery(id: string, text: string): Promise<void>;
  getWebhookInfo(): Promise<{ url: string; pending_update_count: number }>;
}

export class TelegramAPIError extends Error {
  constructor(public readonly code: "rate_limit" | "unauthorized" | "conflict" | "unavailable" | "invalid_response" | "rejected",
    public readonly retryAfter = 0) {
    const messages = {
      rate_limit: "Телеграмын хүсэлтийн хязгаарт хүрлээ. Түр хүлээнэ үү.",
      unauthorized: "Телеграм ботын нэвтрэх эрх буруу байна.",
      conflict: "Телеграмын өөр хүлээн авагч ажиллаж байна. Горимын тохиргоог шалгана уу.",
      unavailable: "Телеграмтай холбогдож чадсангүй. Дахин оролдоно уу.",
      invalid_response: "Телеграмын хариуг шалгаж чадсангүй.",
      rejected: "Телеграм хүсэлтийг хүлээн авсангүй.",
    };
    super(messages[code]);
  }
}

const envelopeSchema = z.object({
  ok: z.boolean(), result: z.unknown().optional(), error_code: z.number().optional(),
  parameters: z.object({ retry_after: z.number().int().positive().max(86400).optional() }).optional(),
});
type ClientOptions = { fetch?: typeof fetch; wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>; attempts?: number };

/** Uses only the official HTTPS Bot API. Raw URLs and provider error descriptions never escape. */
export class TelegramBotAPI implements TelegramAPI {
  private readonly fetcher: typeof fetch;
  private readonly wait: NonNullable<ClientOptions["wait"]>;
  private readonly attempts: number;
  constructor(private readonly token: string, options: ClientOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.wait = options.wait ?? (async (milliseconds, signal) => { await delay(milliseconds, undefined, { signal }); });
    this.attempts = Math.max(1, Math.min(4, options.attempts ?? 3));
  }
  private async call<T>(method: string, payload: Record<string, unknown>, schema: z.ZodType<T>, signal?: AbortSignal,
    timeoutMs = 15000): Promise<T> {
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      signal?.throwIfAborted();
      let failure: TelegramAPIError;
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        const body = envelopeSchema.safeParse(await response.json());
        if (!body.success) throw new TelegramAPIError("invalid_response");
        if (response.ok && body.data.ok) {
          const result = schema.safeParse(body.data.result);
          if (!result.success) throw new TelegramAPIError("invalid_response");
          return result.data;
        }
        const code = body.data.error_code ?? response.status;
        failure = code === 429 ? new TelegramAPIError("rate_limit", body.data.parameters?.retry_after ?? 1)
          : code === 401 ? new TelegramAPIError("unauthorized")
          : code === 409 ? new TelegramAPIError("conflict")
          : code >= 500 ? new TelegramAPIError("unavailable") : new TelegramAPIError("rejected");
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        failure = error instanceof TelegramAPIError ? error : new TelegramAPIError("unavailable");
      }
      const retryable = failure.code === "unavailable" || failure.code === "rate_limit";
      if (!retryable || attempt === this.attempts - 1 || failure.retryAfter > 30) throw failure;
      await this.wait(failure.retryAfter ? failure.retryAfter * 1000 : 500 * 2 ** attempt, signal);
    }
    throw new TelegramAPIError("unavailable");
  }
  getMe() {
    return this.call("getMe", {}, z.object({ id: z.number().int().positive(), is_bot: z.literal(true),
      username: z.string().regex(/^[A-Za-z0-9_]{5,32}$/).optional() }));
  }
  async deleteWebhook() {
    await this.call("deleteWebhook", { drop_pending_updates: false }, z.literal(true));
  }
  async setWebhook(url: string, secret: string) {
    await this.call("setWebhook", { url, secret_token: secret, drop_pending_updates: false,
      allowed_updates: ["message", "callback_query"], max_connections: 1 }, z.literal(true));
  }
  getUpdates(offset: number, signal?: AbortSignal) {
    return this.call("getUpdates", { offset, timeout: 30, limit: 100, allowed_updates: ["message", "callback_query"] },
      z.array(telegramUpdateSchema), signal, 40000);
  }
  sendMessage(chatId: string, text: string, buttons?: InlineKeyboard) {
    return this.call("sendMessage", { chat_id: chatId, text, ...(buttons ? { reply_markup: buttons } : {}) },
      z.object({ message_id: z.number().int() }));
  }
  async answerCallbackQuery(id: string, text: string) {
    await this.call("answerCallbackQuery", { callback_query_id: id, text }, z.literal(true));
  }
  getWebhookInfo() {
    return this.call("getWebhookInfo", {}, z.object({ url: z.string(), pending_update_count: z.number().int().nonnegative() }));
  }
}
