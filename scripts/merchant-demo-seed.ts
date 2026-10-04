import { loadEnvConfig } from "@next/env";
import { demoConfig } from "../merchant/server/demo-auth";
import { readDatabaseEnv } from "../merchant/server/env";
import { closeMerchantConnection, getMerchantClient, getMerchantDb } from "../merchant/server/database";
import { formatMerchantFailure } from "../merchant/server/diagnostics";
import { inspectSeedTarget } from "../merchant/server/seed-check";
import { seedDemoMerchants } from "../merchant/server/seed";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
let stage = "environment loading";
let envLoadFailed = false;
const loaded = loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production", {
  info: () => {}, error: () => { envLoadFailed = true; },
});
async function main() {
  if (args.some(a => a !== "--check")) throw new Error("Unsupported seed argument");
  console.log(`Environment files loaded: ${loaded.loadedEnvFiles.map(f => f.path).join(", ") || "none (shell environment only)"}`);
  if (envLoadFailed) throw new Error("Environment file loading failed");
  if (checkOnly) {
    console.log("READ-ONLY CHECK: no seed writes, index changes, new databases or collections.");
    const keys = ["MONGODB_URI", "MONGODB_DB", "MERCHANT_DEMO_ENABLED", "MERCHANT_DEMO_ORIGIN", "MERCHANT_DEMO_ACCESS_KEY", "MERCHANT_DEMO_SESSION_SECRET"];
    for (const key of keys) console.log(`${key}: ${process.env[key]?.trim() ? "present" : "missing"}${key.endsWith("_KEY") || key.endsWith("_SECRET") ? `; minimum 32 characters ${((process.env[key]?.length ?? 0) >= 32) ? "met" : "not met"}` : ""}`);
  }
  stage = "demo configuration";
  let demoReady = true;
  try { demoConfig(); }
  catch (error) {
    if (!checkOnly) throw error;
    demoReady = false;
    console.error(formatMerchantFailure(error, stage));
  }
  stage = "database configuration";
  readDatabaseEnv();
  try {
    stage = "MongoDB connection";
    const client = await getMerchantClient();
    const db = await getMerchantDb();
    stage = "MongoDB ping / authentication";
    await db.command({ ping: 1 });
    console.log("MongoDB connection and ping: OK");
    console.log(`MongoDB driver authentication: ${client.options.credentials ? "configured credential exchange completed" : "no explicit credentials configured; ping alone does not prove authorization"}`);
    stage = "replica-set / transaction topology";
    const hello = await client.db("admin").command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid") {
      console.error("MongoDB topology: standalone; this seed requires replica-set or sharded transactions.");
      process.exitCode = 1;
      return;
    }
    console.log(`MongoDB topology: ${hello.setName ? "replica set" : "sharded cluster"}; transaction topology supported`);
    if (checkOnly) {
      stage = "read-only seed safety inspection";
      const report = await inspectSeedTarget(db);
      console.log(JSON.stringify(report, null, 2));
      if (!demoReady || !report.databaseAlreadyExists || report.fixtureConflicts || report.retainedAuditConflicts) process.exitCode = 1;
      console.log("No database changes were executed. A successful check does not authorize seeding a shared database.");
      return;
    }
    stage = "seed index initialization / data transaction";
    await seedDemoMerchants(client, db);
    console.log("Five SIMULATED merchants seeded; existing edits preserved.");
  } finally { await closeMerchantConnection(); }
}
main().catch(error => { console.error(formatMerchantFailure(error, stage)); process.exitCode = 1; });
