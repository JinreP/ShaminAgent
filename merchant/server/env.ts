import 'server-only';
import { z } from "zod";

const optional = z.preprocess(v => v === "" ? undefined : v, z.string().min(1).optional());
export const databaseEnvSchema = z.object({
  MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\//),
  MONGODB_DB: z.string().min(1).max(63).regex(/^[A-Za-z0-9_-]+$/),
});
export function readDatabaseEnv(source: Record<string, string | undefined> = process.env) {
  const result = databaseEnvSchema.safeParse(source);
  if (!result.success) throw new Error(`Invalid database environment: ${result.error.issues.map(i => i.path.join(".")).join(", ")}`);
  return result.data;
}
export const merchantEnvSchema = databaseEnvSchema.extend({
  MERCHANT_AI_PROVIDER: z.enum(["gemini", "oyullm"]).optional(),
  AI_PROVIDER: z.enum(["gemini", "oyu"]).optional(),
  GEMINI_API_KEY: optional, GEMINI_MODEL: optional,
  GEMINI_STRUCTURED_OUTPUT_MODE: z.enum(["json", "schema"]).default("json"),
  MERCHANT_SPEECH_PROVIDER: z.enum(["disabled", "anir"]).default("disabled"),
}).superRefine((v, ctx) => {
  const selected = v.AI_PROVIDER === "oyu" ? "oyullm" : v.AI_PROVIDER;
  if (selected && v.MERCHANT_AI_PROVIDER && selected !== v.MERCHANT_AI_PROVIDER)
    ctx.addIssue({ code: "custom", path: ["AI_PROVIDER"], message: "AI provider configuration conflicts" });
  if ((selected ?? v.MERCHANT_AI_PROVIDER ?? "gemini") === "gemini") {
    for (const key of ["GEMINI_API_KEY", "GEMINI_MODEL"] as const)
      if (!v[key]) ctx.addIssue({ code: "custom", path: [key], message: "Required for Gemini" });
  }
}).transform(v => ({ ...v, MERCHANT_AI_PROVIDER: v.AI_PROVIDER === "oyu" ? "oyullm" as const :
  v.AI_PROVIDER ?? v.MERCHANT_AI_PROVIDER ?? "gemini" as const }));
export type MerchantEnv = z.infer<typeof merchantEnvSchema>;
export function readMerchantEnv(source: Record<string, string | undefined> = process.env): MerchantEnv {
  const result = merchantEnvSchema.safeParse(source);
  if (!result.success) throw new Error(`Invalid merchant environment: ${result.error.issues.map(i => i.path.join(".")).join(", ")}`);
  return result.data;
}
