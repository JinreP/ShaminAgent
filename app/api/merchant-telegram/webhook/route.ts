import { getMerchantDb } from "../../../../merchant/server/database";
import { readTelegramConfig } from "../../../../merchant/telegram/config";
import { getTelegramRuntime } from "../../../../merchant/telegram/service";
import { handleTelegramWebhook, validateWebhookRequest } from "../../../../merchant/telegram/webhook";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const config = readTelegramConfig();
    const invalid = validateWebhookRequest(request, config);
    if (invalid) return invalid;
    return await handleTelegramWebhook(request, { config, db: await getMerchantDb(), runtime: await getTelegramRuntime() });
  } catch {
    return Response.json({ error: "Телеграмын хүлээн авагчийн тохиргоо эсвэл холболт бэлэн болоогүй байна." }, { status: 503 });
  }
}
