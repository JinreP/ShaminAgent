import { spawnSync } from "node:child_process";
// No .env loader or shared URI: this suite creates and stops its own local replica set.
const env: NodeJS.ProcessEnv = { ...process.env, MERCHANT_TELEGRAM_LOCAL_INTEGRATION: "true" };
delete env.MERCHANT_TEST_MONGODB_URI;
const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--test", "tests/merchant-telegram.integration.test.ts"], { stdio: "inherit", env });
if (result.error) console.error("Локал Телеграм туршилтыг эхлүүлж чадсангүй.");
process.exitCode = result.status ?? 1;
