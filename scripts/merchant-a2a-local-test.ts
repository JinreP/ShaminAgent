import { spawnSync } from "node:child_process";
// Never loads .env or consumes a configured MongoDB URI. The test starts its own loopback replica set.
const env: NodeJS.ProcessEnv = { ...process.env, MERCHANT_A2A_LOCAL_INTEGRATION: "true" };
delete env.MERCHANT_TEST_MONGODB_URI;
const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--test", "tests/merchant-a2a.integration.test.ts"], { stdio: "inherit", env });
if (result.error) console.error("Локал A2A туршилтыг эхлүүлж чадсангүй.");
process.exitCode = result.status ?? 1;
