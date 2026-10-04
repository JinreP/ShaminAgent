import { loadEnvConfig } from "@next/env";
import { demoConfig } from "../merchant/server/demo-auth";
import { closeMerchantConnection, getMerchantClient, getMerchantDb } from "../merchant/server/database";
import { seedDemoMerchants } from "../merchant/server/seed";

loadEnvConfig(process.cwd());
async function main() {
  demoConfig();
  try {
    await seedDemoMerchants(await getMerchantClient(), await getMerchantDb());
    console.log("Five SIMULATED merchants seeded; existing edits preserved.");
  } finally { await closeMerchantConnection(); }
}
main().catch(() => { console.error("Demo seed failed. Check demo configuration and a disposable MongoDB replica set."); process.exitCode = 1; });
