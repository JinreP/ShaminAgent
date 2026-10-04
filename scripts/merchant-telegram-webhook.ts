import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { closeMerchantConnection, getMerchantDb } from "../merchant/server/database";
import { TelegramBotAPI, TelegramAPIError } from "../merchant/telegram/api";
import { readTelegramConfig, TelegramConfigurationError } from "../merchant/telegram/config";
import { acquireTelegramAdministrationLease, releaseTelegramLease, TelegramTransportConflict } from "../merchant/telegram/worker";

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production", { info: () => {}, error: () => {} });
async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length || !["register", "remove", "status"].includes(command)) {
    throw new Error("Командыг сонгоно уу: register, remove, status.");
  }
  // A single bounded administrative call finishes within the short maintenance lease.
  const config = readTelegramConfig(), api = new TelegramBotAPI(config.token, { attempts: 1 });
  if (command === "status") {
    const info = await api.getWebhookInfo();
    console.log(`Телеграмын HTTPS хүлээн авагч: ${info.url ? "бүртгэлтэй" : "бүртгэлгүй"}; хүлээгдэж буй хүсэлт: ${info.pending_update_count}`);
    return;
  }
  if (command === "register" && config.mode !== "webhook") throw new TelegramTransportConflict();
  const db = await getMerchantDb(), owner = randomUUID();
  // Require all workers to stop first. The same singleton lease closes the registration/start race.
  await acquireTelegramAdministrationLease(db, config, owner);
  try {
    if (command === "register") await api.setWebhook(config.webhookUrl!, config.webhookSecret!);
    else await api.deleteWebhook();
    console.log(command === "register" ? "Телеграмын HTTPS хүлээн авагч бүртгэгдлээ." : "Телеграмын HTTPS хүлээн авагчийн бүртгэл цуцлагдлаа.");
  } finally { await releaseTelegramLease(db, config, owner); }
}
main().catch(error => {
  console.error(error instanceof TelegramAPIError || error instanceof TelegramTransportConflict || error instanceof TelegramConfigurationError ? error.message
    : "Телеграмын бүртгэлийг өөрчилж чадсангүй. Команд, орчны тохиргоо, MongoDB холболтыг шалгана уу.");
  process.exitCode = 1;
}).finally(async () => { await closeMerchantConnection(); });
