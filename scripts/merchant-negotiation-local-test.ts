import { spawnSync } from "node:child_process";
// This suite owns its ephemeral replica set and never loads a shared database URI.
const env: NodeJS.ProcessEnv = { ...process.env, MERCHANT_NEGOTIATION_LOCAL_INTEGRATION: "true" };
delete env.MERCHANT_TEST_MONGODB_URI;
const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--test", "tests/merchant-negotiation.integration.test.ts"], { stdio: "inherit", env });
if (result.error) console.error("Локал хэлэлцээний туршилтыг эхлүүлж чадсангүй.");
process.exitCode = result.status ?? 1;
