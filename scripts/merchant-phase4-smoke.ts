import { loadEnvConfig } from "@next/env";
import { createAIProvider } from "../merchant/server/providers";
import { readMerchantEnv } from "../merchant/server/env";
import { demoSeedRecords } from "../merchant/server/seed";
import { inventorySchema } from "../merchant/private-contracts";
import { merchantProfileSchema, type RFQ } from "../shared/merchant-contracts";
import { extractQuoteDraft } from "../merchant/telegram/extraction";
import { TelegramBotAPI } from "../merchant/telegram/api";

// Explicit external API smoke. No Mongo connection, webhook mutation, merchant notification or production Buyer runs.
loadEnvConfig(process.cwd());
async function main() {
  const mode = process.argv[2];
  if (mode === "gemini") {
    const merchantId = "demo-japan-used", fixtures = demoSeedRecords().filter(f => f.record.merchantId === merchantId);
    const rfq: RFQ = { contractVersion: "1", id: "live-smoke-rfq", merchantId, buyerId: "isolated-smoke", createdAt: new Date().toISOString(),
      kind: "parts", vehicle: { make: "Toyota", model: "Prius 30", year: 2012 }, items: [{ description: "Урд гупер", quantity: 1 }], status: "received" };
    const provider = createAIProvider(readMerchantEnv());
    const draft = await extractQuoteDraft({ async generate(request) {
      try { return await provider.generate(request); }
      catch (error) {
        const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : undefined;
        const text = error instanceof Error ? error.message.toLowerCase() : "";
        const reason = /api_key_invalid|api key not valid|api key expired/.test(text) ? "API түлхүүр хүчингүй байна." :
          /not found|not supported.*model/.test(text) ? "Тохируулсан загвар эсвэл structured output дэмжлэг олдсонгүй." :
            /quota|resource_exhausted/.test(text) ? "API квотын хязгаарт хүрсэн байна." :
              /schema|response_json_schema/.test(text) ? "Structured output schema хүсэлтийг API хүлээн аваагүй." : "API холболт эсвэл нэвтрэх эрхийг шалгана уу.";
        console.error(`Gemini хүсэлт амжилтгүй: ${status && [400,401,403,404,408,429,500,502,503,504].includes(status) ? `HTTP ${status}. ` : ""}${reason}`);
        // This explicit developer smoke may report a concise upstream cause, after
        // removing credentials and URLs. Normal Telegram responses remain generic.
        let safeCause = error instanceof Error ? error.message : "";
        try { const body = JSON.parse(safeCause); safeCause = body.error?.message ?? body.message ?? safeCause; } catch { /* Not JSON. */ }
        for (const [key, value] of Object.entries(process.env)) {
          if (value && value.length > 3 && /key|token|secret|password|uri|url|credential|gemini_model/i.test(key))
            safeCause = safeCause.split(value).join("[НУУЦЛАВ]");
        }
        safeCause = safeCause.replace(/(?:https?|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi, "[ХАЯГ НУУЦЛАВ]")
          .replace(/AIza[A-Za-z0-9_-]{20,}/g, "[НУУЦЛАВ]").replace(/[\r\n]+/g, " ").slice(0, 600);
        console.error(`API шалтгаан: ${safeCause}`);
        throw new Error("Бодит Gemini хүсэлт амжилтгүй.");
      }
    } }, rfq, {
      profile: merchantProfileSchema.parse(fixtures.find(f => f.resource === "profile")!.record),
      inventory: fixtures.filter(f => f.resource === "inventory").map(f => inventorySchema.parse(f.record)), services: [], slots: [],
    }, "Приус 30 урд гупер 280 мянган төгрөг, хуучин, одоо бэлэн.");
    if (draft.lines[0].unitPrice?.amountMinor !== 28000000 || draft.lines[0].condition !== "used" || draft.lines[0].available !== true ||
        draft.lines[0].resourceId !== "demo-japan-used-bumper") throw new Error();
    console.log("Gemini бодит extraction шалгалт тэнцлээ. Монгол хариу, үнэ, төлөв, боломж болон resource ID зөв танигдсан. Үнийн санал нийтлээгүй.");
  } else if (mode === "telegram" && process.env.TELEGRAM_BOT_TOKEN) {
    await new TelegramBotAPI(process.env.TELEGRAM_BOT_TOKEN).getMe();
    console.log("Телеграмын бодит ботын эрхийг getMe үйлдлээр баталгаажууллаа. Хэрэглэгчид мэдэгдэл илгээгээгүй.");
  } else throw new Error();
}
main().catch(() => { console.error("Бодит API шалгалт тэнцсэнгүй. Тохиргоо, API эрх болон холболтыг шалгана уу. Нууц мэдээлэл хэвлээгүй."); process.exitCode = 1; });
