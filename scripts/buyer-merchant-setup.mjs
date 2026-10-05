import nextEnv from "@next/env";
import { randomBytes } from "node:crypto";
import { readFile, appendFile } from "node:fs/promises";

// Local configuration only: does not contact MongoDB or any provider.
nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
if (process.env.NODE_ENV === "production") throw new Error("Run local demo setup in development.");
const origin = process.env.BUYER_MERCHANT_ORIGIN ?? process.env.MERCHANT_A2A_ORIGIN ?? "http://localhost:3000";
const url = new URL(origin);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.origin !== origin) {
  throw new Error("Use a loopback origin without a trailing slash.");
}
const secret = () => randomBytes(32).toString("hex");
const buyer = process.env.BUYER_MERCHANT_BUYER_ID ?? process.env.MERCHANT_A2A_DEMO_BUYER_ID ?? process.env.MERCHANT_MCP_BUYER_ID ?? "demo-buyer";
const a2aToken = process.env.BUYER_MERCHANT_A2A_TOKEN ?? process.env.MERCHANT_A2A_DEMO_TOKEN ?? secret();
const mcpToken = process.env.BUYER_MERCHANT_MCP_TOKEN ?? process.env.MERCHANT_MCP_TOKEN ?? secret();
const required = {
  BUYER_MERCHANT_ORIGIN: origin, BUYER_MERCHANT_BUYER_ID: buyer,
  BUYER_MERCHANT_A2A_TOKEN: a2aToken, BUYER_MERCHANT_MCP_TOKEN: mcpToken,
  MERCHANT_A2A_ORIGIN: origin, MERCHANT_A2A_AUTH_MODE: "demo", MERCHANT_A2A_DEMO_ENABLED: "true",
  MERCHANT_A2A_DEMO_TOKEN: a2aToken, MERCHANT_A2A_DEMO_BUYER_ID: buyer,
  MERCHANT_MCP_ENABLED: "true", MERCHANT_MCP_AUTH_MODE: "token", MERCHANT_MCP_TOKEN: mcpToken,
  MERCHANT_MCP_BUYER_ID: buyer,
  MERCHANT_MCP_MERCHANT_IDS: "demo-prius-parts,demo-japan-used,demo-oem-center,demo-auto-care,demo-quick-garage",
  MERCHANT_MCP_APPROVAL_ORIGIN: origin, MERCHANT_DEMO_ENABLED: "true", MERCHANT_DEMO_ORIGIN: origin,
  MERCHANT_DEMO_ACCESS_KEY: process.env.MERCHANT_DEMO_ACCESS_KEY ?? secret(),
  MERCHANT_DEMO_SESSION_SECRET: process.env.MERCHANT_DEMO_SESSION_SECRET ?? secret(),
};
for (const [key, value] of Object.entries(required)) {
  if (process.env[key] !== undefined && process.env[key] !== value) throw new Error(`Existing ${key} conflicts with demo setup. Resolve this value before rerunning; nothing was written.`);
}
if (a2aToken.length < 32 || mcpToken.length < 32) throw new Error("Service tokens must be at least 32 characters.");
const text = await readFile(".env.local", "utf8").catch(error => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const additions = Object.entries(required).filter(([key]) => !new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, "m").test(text));
if (additions.length) {
  await appendFile(".env.local", "\n# Local Buyer / Merchant integration\n" + additions.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n", { mode: 0o600 });
}
console.log(`Added ${additions.length} local settings. Existing MongoDB/Gemini values were preserved; no secrets printed. Restart npm run dev.`);
