import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";

const optional = z.preprocess(value => value === "" ? undefined : value, z.string().optional());
export const telegramConfigSchema = z.object({
  MERCHANT_TELEGRAM_ENABLED: z.literal("true"),
  TELEGRAM_BOT_TOKEN: z.string().regex(/^[0-9]+:[A-Za-z0-9_-]{20,}$/),
  TELEGRAM_MODE: z.enum(["polling", "webhook"]).default("polling"),
  TELEGRAM_WEBHOOK_URL: optional,
  TELEGRAM_WEBHOOK_SECRET: optional,
  MERCHANT_TELEGRAM_AUTH_MODE: z.enum(["demo", "production"]).default("production"),
  MERCHANT_TELEGRAM_DEMO_ENABLED: z.enum(["true", "false"]).default("false"),
  NODE_ENV: optional,
}).superRefine((value, context) => {
  if (value.MERCHANT_TELEGRAM_AUTH_MODE === "demo" &&
      (value.MERCHANT_TELEGRAM_DEMO_ENABLED !== "true" || value.NODE_ENV === "production")) {
    context.addIssue({ code: "custom", path: ["MERCHANT_TELEGRAM_AUTH_MODE"], message: "Туршилтын нэвтрэлт зөвшөөрөгдөөгүй." });
  }
  if (value.TELEGRAM_MODE === "polling") {
    for (const key of ["TELEGRAM_WEBHOOK_URL", "TELEGRAM_WEBHOOK_SECRET"] as const) {
      if (value[key]) context.addIssue({ code: "custom", path: [key], message: "Хүлээн авах хоёр горимыг зэрэг тохируулж болохгүй." });
    }
  } else {
    let url: URL | undefined;
    try { url = new URL(value.TELEGRAM_WEBHOOK_URL ?? ""); } catch { /* Report only the field name. */ }
    if (!url || url.protocol !== "https:" || url.username || url.password || url.hash || url.search ||
        (url.port && !["443", "80", "88", "8443"].includes(url.port))) {
      context.addIssue({ code: "custom", path: ["TELEGRAM_WEBHOOK_URL"], message: "HTTPS хаяг шаардлагатай." });
    }
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(value.TELEGRAM_WEBHOOK_SECRET ?? "")) {
      context.addIssue({ code: "custom", path: ["TELEGRAM_WEBHOOK_SECRET"], message: "Нууц түлхүүр 32–256 тэмдэгттэй байна." });
    }
  }
});

export type TelegramConfig = {
  enabled: true;
  token: string;
  mode: "polling" | "webhook";
  merchantAuthMode: "demo" | "production";
  demoEnabled: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  /** A one-way identifier used for the worker lease, never the bot credential. */
  botKey: string;
};

export class TelegramConfigurationError extends Error {
  constructor(fields: string[]) { super(`Телеграмын тохиргоо буруу байна: ${fields.join(", ")}`); }
}

export function readTelegramConfig(source: Record<string, string | undefined> = process.env): TelegramConfig {
  const parsed = telegramConfigSchema.safeParse(source);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join(".")))];
    throw new TelegramConfigurationError(fields);
  }
  const value = parsed.data;
  return {
    enabled: true, token: value.TELEGRAM_BOT_TOKEN, mode: value.TELEGRAM_MODE,
    merchantAuthMode: value.MERCHANT_TELEGRAM_AUTH_MODE,
    demoEnabled: value.MERCHANT_TELEGRAM_DEMO_ENABLED === "true",
    webhookUrl: value.TELEGRAM_WEBHOOK_URL, webhookSecret: value.TELEGRAM_WEBHOOK_SECRET,
    botKey: createHash("sha256").update(value.TELEGRAM_BOT_TOKEN).digest("hex"),
  };
}
