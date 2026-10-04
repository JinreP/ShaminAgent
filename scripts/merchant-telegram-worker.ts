import { loadEnvConfig } from "@next/env";
import { closeMerchantConnection, getMerchantDb } from "../merchant/server/database";
import { TelegramBotAPI, TelegramAPIError } from "../merchant/telegram/api";
import { readTelegramConfig, TelegramConfigurationError } from "../merchant/telegram/config";
import { getTelegramRuntime } from "../merchant/telegram/service";
import { runTelegramWorker, TelegramTransportConflict } from "../merchant/telegram/worker";

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production", { info: () => {}, error: () => {} });
async function main() {
  if (process.argv.length > 2) throw new Error("Аргумент шаардлагагүй. Горимыг TELEGRAM_MODE хувьсагчаар сонгоно уу.");
  const config = readTelegramConfig();
  try {
    await runTelegramWorker({ config, db: await getMerchantDb(), telegram: new TelegramBotAPI(config.token),
      runtime: await getTelegramRuntime(), signal: shutdown.signal });
  } finally { await closeMerchantConnection(); }
}
main().catch(error => {
  console.error(error instanceof TelegramAPIError || error instanceof TelegramTransportConflict || error instanceof TelegramConfigurationError ? error.message
    : "Телеграмын ажиллагчийг эхлүүлж чадсангүй. Орчны тохиргоо, MongoDB холболтыг шалгана уу.");
  process.exitCode = 1;
});
