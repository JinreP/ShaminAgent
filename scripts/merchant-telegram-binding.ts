import { loadEnvConfig } from "@next/env";
import { z } from "zod";
import { closeMerchantConnection, getMerchantClient, getMerchantDb } from "../merchant/server/database";
import { explainMerchantFailure } from "../merchant/server/diagnostics";
import { DEMO_MERCHANTS } from "../merchant/demo-merchants";
import { readDatabaseEnv } from "../merchant/server/env";
import { readTelegramConfig, TelegramConfigurationError } from "../merchant/telegram/config";
import { TelegramMerchantStore, TelegramStoreError } from "../merchant/telegram/store";
import { telegramIdentitySchema } from "../merchant/telegram/contracts";

class BindingCliError extends Error {}

type Action =
  | { kind: "issue"; merchantId: string; userId: string }
  | { kind: "list" }
  | { kind: "revoke"; bindingId: string };

function parseAction(args: string[]): Action {
  const [action, ...values] = args;
  if (action === "list" && values.length === 0) return { kind: "list" };
  if (action === "issue" && values.length === 2) {
    const [merchantId, userId] = values;
    if (!DEMO_MERCHANTS.some(merchant => merchant.id === merchantId))
      throw new BindingCliError("Туршилтын худалдаачны дугаар буруу байна. Жишээ: demo-prius-parts.");
    if (!telegramIdentitySchema.safeParse(userId).success)
      throw new BindingCliError("Телеграм хэрэглэгчийн ID нь зөвхөн тооноос бүрдэх ёстой. @user нэр эсвэл TELEGRAM_USER_ID гэсэн жишээ утга бүү оруулна уу.");
    return { kind: "issue", merchantId, userId };
  }
  if (action === "revoke" && values.length === 1 && /^tb-[A-Za-z0-9-]+$/.test(values[0]))
    return { kind: "revoke", bindingId: values[0] };
  throw new BindingCliError("Команд буруу байна. Хэрэглээ: issue <demo-merchant-id> <numeric-telegram-user-id> | list | revoke <binding-id>.");
}

let stage = "environment loading";
let envLoadFailed = false;
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production", {
  info: () => {},
  error: () => { envLoadFailed = true; },
});

async function main() {
  if (envLoadFailed)
    throw new BindingCliError("Орчны тохиргооны файлыг уншиж чадсангүй. Файлын зөвшөөрөл болон мөрийн бүтцийг локал шалгана уу.");
  stage = "command arguments";
  const action = parseAction(process.argv.slice(2));
  stage = "Telegram configuration";
  const config = readTelegramConfig();
  stage = "MongoDB configuration";
  readDatabaseEnv();
  stage = "MongoDB connection";
  const client = await getMerchantClient();
  const db = await getMerchantDb();
  stage = "MongoDB authorization";
  await db.command({ ping: 1 });

  if (action.kind === "list") {
    stage = "binding list";
    const bindings = await db.collection("merchant_telegram_bindings").find({
      active: true, mode: config.merchantAuthMode,
    }, { projection: { _id: 0, id: 1, merchantId: 1, userId: 1, mode: 1 } }).toArray();
    console.log(JSON.stringify(bindings, null, 2));
    return;
  }

  const store = new TelegramMerchantStore(client, db);
  if (action.kind === "issue") {
    stage = "invite creation";
    const invite = await store.issueInvite(action.merchantId, action.userId, config.merchantAuthMode, "telegram-admin-cli");
    console.log("Нэг удаагийн бүртгэлийн код (15 минут хүчинтэй). Зөвхөн заасан хэрэглэгчид хувийн сувгаар дамжуулна уу:");
    console.log(`/start ${invite.token}`);
    return;
  }

  stage = "binding revocation";
  await store.revokeBinding(action.bindingId, "telegram-admin-cli");
  console.log("Худалдаачны Телеграм холбоосыг хүчингүй болголоо.");
}

function failureMessage(error: unknown): string {
  if (error instanceof BindingCliError) return error.message;
  if (error instanceof TelegramConfigurationError)
    return `${error.message}. Нууц утгыг терминалд хэвлэлгүйгээр локал шалгана уу.`;
  if (error instanceof TelegramStoreError) return error.message;
  const failure = explainMerchantFailure(error);
  if (failure.category !== "unknown") return `${failure.message}${failure.hint ? ` ${failure.hint}` : ""}`;
  if (error instanceof z.ZodError) {
    const fields = [...new Set(error.issues.map(issue => issue.path.join(".")).filter(Boolean))];
    return `Командын эсвэл өгөгдлийн талбар буруу байна${fields.length ? `: ${fields.join(", ")}` : ""}.`;
  }
  return `[${stage}] Үйлдэл амжилтгүй. Команд, хандалтын эрх болон холболтыг шалгана уу. Алдааны дэлгэрэнгүй болон нууц утгууд хэвлэгдсэнгүй.`;
}

main()
  .catch(error => {
    console.error(failureMessage(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeMerchantConnection();
    } catch {
      console.error("MongoDB холболтыг аюулгүй хааж чадсангүй.");
      process.exitCode = 1;
    }
  });
