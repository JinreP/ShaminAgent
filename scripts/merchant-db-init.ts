import { loadEnvConfig } from "@next/env";
import { closeMerchantConnection, getMerchantDb, initializeMerchantDatabase } from "../merchant/server/database";

loadEnvConfig(process.cwd());
async function main() {
  try { await initializeMerchantDatabase(await getMerchantDb()); console.log("Merchant collections and indexes initialized"); }
  finally { await closeMerchantConnection(); }
}
main().catch(() => { console.error("Merchant database initialization failed; check configuration and database access"); process.exitCode = 1; });
