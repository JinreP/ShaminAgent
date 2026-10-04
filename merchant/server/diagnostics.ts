import "server-only";
import { MerchantAccessError } from "./demo-auth";

export type SafeFailure = { category: string; message: string; codes: (string | number)[]; hint?: string };
const safeCodes = new Set([
  "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR", "ERR_SSL_CERTIFICATE_VERIFY_FAILED", "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION", "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH",
  "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
]);

// Inspect driver causes locally, but never print messages, stacks, URIs, credentials or server addresses.
export function explainMerchantFailure(error: unknown): SafeFailure {
  const queue: unknown[] = [error];
  const visited = new Set<object>();
  const codes = new Set<string | number>();
  const messages: string[] = [];
  const names: string[] = [];
  while (queue.length && visited.size < 64) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    const item = value as Record<string, unknown>;
    if (typeof item.message === "string") messages.push(item.message);
    if (typeof item.name === "string") names.push(item.name);
    if (typeof item.code === "number" && Number.isSafeInteger(item.code)) codes.add(item.code);
    // Only known platform error codes can be printed; arbitrary strings may contain secrets.
    if (typeof item.code === "string" && safeCodes.has(item.code)) codes.add(item.code);
    queue.push(item.cause, item.reason, item.error);
    if (item.servers instanceof Map) queue.push(...item.servers.values());
  }
  const details = Array.from(codes).sort((a, b) => String(a).localeCompare(String(b)));
  const diagnostic = (category: string, message: string, hint?: string): SafeFailure => ({ category, message, codes: details, ...(hint ? { hint } : {}) });
  if (error instanceof MerchantAccessError) {
    if (/^Merchant demo is disabled/.test(error.message)) return diagnostic("demo_configuration", "Merchant demo is disabled.", "Set MERCHANT_DEMO_ENABLED=true for local use; NODE_ENV=production always rejects demo access.");
    if (/^Merchant demo configuration is incomplete/.test(error.message)) {
      const fields = ["MERCHANT_DEMO_ORIGIN", "MERCHANT_DEMO_ACCESS_KEY", "MERCHANT_DEMO_SESSION_SECRET"].filter(key => error.message.includes(key));
      return diagnostic("demo_configuration", `Merchant demo configuration is incomplete${fields.length ? `: ${fields.join(", ")}` : ""}.`, "Both demo secrets require at least 32 characters; the origin must be the exact loopback URL.");
    }
    if (/^(Invalid demo origin|Demo origin must be a loopback origin)/.test(error.message)) return diagnostic("demo_configuration", "MERCHANT_DEMO_ORIGIN must be an exact loopback HTTP/HTTPS origin without a path or trailing slash.");
  }
  const configError = messages.find(m => /^Invalid database environment:/.test(m));
  if (configError) {
    const fields = ["MONGODB_URI", "MONGODB_DB"].filter(key => configError.includes(key));
    return diagnostic("database_configuration", `Invalid database environment: ${fields.join(", ")}.`, "Use the existing MongoDB URI and a database name containing letters, digits, underscores or hyphens.");
  }
  if (codes.has(18) || codes.has(8000) || messages.some(m => /authentication failed|bad auth|auth failed/i.test(m)))
    return diagnostic("authentication", "MongoDB rejected database authentication.", "Check the existing database user's access and URI/authSource configuration; no credentials have been changed.");
  if (codes.has(13)) return diagnostic("authorization", "MongoDB authentication succeeded but this operation is not authorized.", "The normal seed needs read, write and index-management permissions in the existing database.");
  if (details.some(c => typeof c === "string" && /ERR_SSL_|ERR_TLS_|CERT_|DEPTH_|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(c)) || messages.some(m => /TLS|SSL|certificate/i.test(m)))
    return diagnostic("tls", "MongoDB TLS handshake failed before authentication could be verified.", "Check Atlas IP access and cluster status, then firewall/VPN/TLS inspection. TLS verification remains enabled.");
  if (codes.has("ENOTFOUND") || codes.has("EAI_AGAIN") || messages.some(m => /querySrv|queryTxt|DNS|ENOTFOUND/i.test(m)))
    return diagnostic("dns", "MongoDB DNS/SRV resolution failed.", "Check DNS connectivity and that the existing Atlas cluster is running.");
  if (codes.has(20) || messages.some(m => /Transaction numbers are only allowed|does not support transactions/i.test(m)))
    return diagnostic("topology", "MongoDB transactions require a replica set or sharded cluster; a standalone server is unsupported.");
  if (codes.has(11000)) return diagnostic("duplicate_key", "MongoDB rejected a duplicate key.", "Read-only checks should inspect fixture/audit collisions. No records should be deleted to force the seed.");
  if (codes.has(85) || codes.has(86)) return diagnostic("index_conflict", "Existing MongoDB index definitions conflict with merchant indexes.", "Review existing indexes with the shared database owner; the diagnostic does not modify them.");
  if (names.includes("MongoParseError") || names.includes("MongoInvalidArgumentError")) return diagnostic("database_configuration", "MongoDB URI/options could not be parsed; credential values are omitted.");
  if (codes.has("ECONNREFUSED")) return diagnostic("network", "MongoDB TCP connection was refused.", "Check the existing server and outbound network access.");
  if (names.includes("MongoServerSelectionError") || details.some(c => typeof c === "string" && /ETIMEDOUT|ECONN|ENET|EHOST/.test(c)))
    return diagnostic("network", "No MongoDB server became reachable within the connection timeout.", "Check Atlas network access, cluster availability and outbound connectivity.");
  if (messages.some(m => m === "Demo identity conflicts with an existing merchant")) return diagnostic("seed_conflict", "A simulated demo identity conflicts with an existing merchant. No fixture replacement is permitted.");
  if (messages.some(m => m === "Environment file loading failed")) return diagnostic("environment_loading", "An environment file could not be loaded; file contents are omitted.", "Check file syntax and permissions locally without posting credential values.");
  if (messages.some(m => m === "Unsupported seed argument")) return diagnostic("arguments", "Unsupported seed argument. Use --check for read-only diagnostics, or no arguments for normal seeding.");
  return diagnostic("unknown", "Merchant operation failed; raw error details were withheld to protect secrets.");
}

export function formatMerchantFailure(error: unknown, stage: string): string {
  const failure = explainMerchantFailure(error);
  return `[${stage}] ${failure.category}: ${failure.message}${failure.codes.length ? ` Codes: ${failure.codes.join(", ")}.` : ""}${failure.hint ? ` ${failure.hint}` : ""}`;
}
