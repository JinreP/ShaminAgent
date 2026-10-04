# Phase 4 — Телеграм худалдаачны бот, Gemini

Phase 4 нь одоо байгаа таван Merchant Agent-д хүний үнийн саналын урсгал нэмнэ. `demo-prius-parts`, `demo-japan-used`, `demo-oem-center`, `demo-auto-care`, `demo-quick-garage` identity болон A2A endpoint/Card/discovery хаяг хэвээр. Buyer Agent болон Buyer-ийн апп өөрчлөгдөөгүй. Бүх худалдаачин, бараа, үйлчилгээ туршилтын өгөгдөлтэй; Телеграм production authentication сонгох нь эдгээрийг бодит бараа болгохгүй. Phase 5 эхлээгүй.

## Хэрэгжсэн урсгал

1. A2A RFQ-ийн MongoDB transaction нь RFQ, анхны автомат Quote, audit, processing cache болон худалдаачны мэдэгдлийн outbox-г хамтад нь хадгална. Телеграмын холболт автомат хариуг хүлээлгэхгүй.
2. Тусдаа ажиллагч мэдэгдлийг тухайн худалдаачны зөвшөөрөгдсөн хувийн чатад илгээнэ. Машин, хүссэн бараа/засвар, тоо, сонголт, хүсэлтийн дугаар, хугацаа харагдана. Buyer ID, VIN, хувийн үнийн хязгаар илгээхгүй.
3. Худалдаачин **Хариу өгөх** товчоор хүсэлтээ сонгох эсвэл хүсэлтийн мэдэгдэлд reply хийнэ. Дараагийн Монгол хариу зөвхөн тэр binding/RFQ-д холбогдоно.
4. Хариу текст хадгалагдсаны дараа одоо байгаа `AIProvider`-ийн Gemini adapter бүтцэт ноорог гаргана. Дутуу үнэ, төлөв, боломж эсвэл засварын цагийг `null` гэж тэмдэглэн тодруулна.
5. Ноорог дээр **Баталгаажуулах**, **Засах**, **Татгалзах** товч харагдана. Шаардлагатай мэдээлэл дутуу үед баталгаажуулах товч байхгүй. Засах нь өмнөх review нооргийг хааж, бүтэн шинэ хариу шаардана.
6. Зөвхөн explicit confirmation-ийн transaction шинэ Quote revision, publication, draft status болон audit хадгална. Сервер шинэчилсэн үнэ, хувийн зөвшөөрөгдсөн үнийн дүрэм, нөөц, compatibility, үйлчилгээ, сонгосон цаг, RFQ хугацааг шалгана. Алдаа хувийн floor/discount утгыг задлахгүй.
7. Buyer нь одоогийн A2A `SendMessage`-ээр `get_quote_updates` илгээж хүний баталгаажсан хувилбарыг авна. Нөөц, цаг захиалахгүй; approval, order, booking, payment, MCP execution энэ Phase-д нэмээгүй.

## Орчны тохиргоо

[merchant-telegram.env.example](merchant-telegram.env.example)-ийн шаардлагатай мөрүүдийг одоогийн `.env.local` эсвэл нууцын менежментэд нэмнэ. Одоо байгаа MongoDB credentials-ийг өөрчилж, database/cluster шинээр үүсгэх шаардлагагүй. A2A нэвтрэлт тусдаа хэвээр; [Phase 3-ийн тохиргоо](merchant-phase3.md) ашиглана. Үндсэн `.env.example`-ийг сэргээгээгүй.

- `MONGODB_URI`, `MONGODB_DB`: одоо байгаа merchant replica-set холболт. Standalone MongoDB transaction дэмжихгүй.
- `MERCHANT_TELEGRAM_ENABLED=true`: ботыг зориуд идэвхжүүлнэ; тохиргоогүй үед шинэ webhook route аюулгүйгээр 503 өгнө.
- `TELEGRAM_BOT_TOKEN`: BotFather-аас авсан серверийн credential.
- `TELEGRAM_MODE=polling`: локал default. Энэ үед webhook URL болон secret хоосон байна.
- `TELEGRAM_MODE=webhook`: HTTPS URL болон secret хоёулаа шаардлагатай.
- `TELEGRAM_WEBHOOK_URL`: `https://.../api/merchant-telegram/webhook`; query, fragment, URL credentials зөвшөөрөхгүй.
- `TELEGRAM_WEBHOOK_SECRET`: 32–256 ASCII үсэг/тоо/underscore/hyphen. Bot token-оос тусдаа санамсаргүй нууц ашиглана.
- `MERCHANT_TELEGRAM_AUTH_MODE=production`: администраторын зөвшөөрсөн холбоос. Default нь production.
- Локал demo-д `MERCHANT_TELEGRAM_AUTH_MODE=demo`, `MERCHANT_TELEGRAM_DEMO_ENABLED=true`; `NODE_ENV=production` үед demo хориглогдоно. Demo болон production холбоос тусдаа хүрээтэй.
- `AI_PROVIDER=gemini`, `GEMINI_API_KEY`, `GEMINI_MODEL`: structured output дэмждэг, тухайн credential-д боломжтой Gemini загвар.
- `GEMINI_STRUCTURED_OUTPUT_MODE=json|schema`: default `json` нь JSON MIME, prompt дахь бүтцийн заавар, strict Zod validation ашиглана; upstream full schema enforcement шаардахгүй. `schema` opt-in нь албан ёсны SDK `responseSchema` ашиглана, загварын нийцлийг тусад нь шалгах шаардлагатай.
- Өмнөх `MERCHANT_AI_PROVIDER=gemini|oyullm` хэвээр дэмжигдэнэ. `AI_PROVIDER=oyu` нь `oyullm` adapter сонгоно. Хоёр хувьсагчийг зэрэг өгвөл нийцээгүй сонголт rejected болно.
- `MERCHANT_SPEECH_PROVIDER=disabled`: одоогийн default. `anir` adapter placeholder хэвээр; voice transcription хэрэгжээгүй.

`AI_PROVIDER=oyu` сонгох боломжтой боловч баримтжуулсан API байхгүй тул generation explicit not-configured алдаа өгнө. OyuLLM/Anir endpoint зохиогоогүй. Gemini request timeout 30 секунд; server-side бизнесийн validation нь AI-ээс хамаарахгүй.

## Локал polling ажиллуулах

1. [BotFather](https://t.me/BotFather)-т `/newbot` ашиглаж өөрийн бот үүсгэнэ. Token-ийг server-only орчны хувьсагчид хадгална. Dashboard холболтын үед ботын username-ийг Telegram `getMe`-ээр шалгана.
2. Polling тохиргоог сонгоно. Баталгаажсан merchant профайл болон Phase 2 fixture өгөгдөл байх шаардлагатай. Тусгай seed командгүйгээр эдгээрийг дарж бичихгүй.
3. Зөвшөөрсөн өөрийн орчинд шинэ индексүүдийг одоогийн `npm run merchant:db:init` командаар нэмнэ. Энэ команд индекс үүсгэнэ; shared Atlas дээр энэ хөгжүүлэлтийн үеэр ажиллуулаагүй. Replica-set холболт ажиллахгүй бол ботоос өмнө MongoDB асуудлыг засна.
4. Хакатоны demo-д худалдаачин нэвтэрсэн самбарын **Телеграм холбох** товчоор богино хугацааны, нэг удаагийн холбоос гаргана. Numeric Telegram user ID шаардахгүй.
5. Next.js болон ботын ажиллагчийг хоёр тусдаа terminal/process-д эхлүүлнэ:

```sh
npm run dev
```

```sh
npm run merchant:telegram:dev
```

Ажиллагч `getMe`-ээр эрхээ шалгаж, polling эхлэхийн өмнө webhook-ийг устгана. `drop_pending_updates=false` тул хүлээгдэж байгаа update-уудыг устгахгүй. `getUpdates` long poll нь 30 секунд. Эдгээр ажиллагаа [Telegram Bot API](https://core.telegram.org/bots/api#getupdates)-тай нийцнэ. Next.js import/hot reload нь polling эхлүүлэхгүй.

MongoDB-ийн бот тус бүрийн singleton lease давхар ажиллагчийг хориглоно. Ажиллагчийн lease 90 секунд, heartbeat 15 секунд; SIGINT/SIGTERM үед long poll тасалж, lease чөлөөлөн холболт хаана. Long poll offset амжилттай update-ийн дараа MongoDB-д хадгалагдана. Restart ижил offset-оос үргэлжилнэ. API rate limit `retry_after`, transient failure болон notification outbox-ийн backoff дэмжигдсэн.

## Худалдаачны самбараас Telegram холбох

Хакатоны туршилтын орчинд худалдаачин `/merchant` самбарт нэвтэрч **Телеграм холбох** товчийг дарна. Сервер signed demo session-оос merchant identity-г авч, зөвхөн тухайн merchant-д зориулсан санамсаргүй холбоос гаргана. Холбоос 5 минут хүчинтэй, нэг удаа хэрэглэгдэнэ; Telegram user ID-г урьдчилан оруулахгүй. Dashboard-аас гарсан холбоос Telegram bot-ийн username-ийг `getMe`-ээр шалгаж, bot руу шууд нээнэ. Худалдаачин bot-ийн хувийн чатад **Start** дарахад webhook/polling ажиллагч нэг удаагийн token-ийг баталгаажуулж Telegram хэрэглэгчийн ID-г тухайн merchant-д холбож хадгална. Самбар холболтын төлөвийг харуулж, **Холболт салгах** үйлдэл active binding болон ашиглагдаагүй dashboard холбоосуудыг хүчингүй болгоно.

Холбоос үүсгэх/салгах хүсэлт нь demo session cookie болон same-origin шалгалт шаарддаг; URL-г merchant ID-гаар сонгох боломжгүй. Token-ийн hash л MongoDB-д хадгалагдана. Нэг demo merchant-д нэг идэвхтэй Telegram binding зөвшөөрөгдөнө. Туршилтын dashboard болон Telegram auth mode нь `MERCHANT_TELEGRAM_AUTH_MODE=demo`, `MERCHANT_TELEGRAM_DEMO_ENABLED=true` гэж тохируулагдсан байх ёстой. Энэ нь hackathon/demo authentication; production merchant login шинээр нэмээгүй.

## Администраторын холбоос, хүчингүй болгох

Нэвтрэлтгүй/public binding удирдах endpoint байхгүй. Дээрх dashboard арга нь зөвхөн баталгаажсан demo merchant session-д нээлттэй. CLI нь урьдчилан мэдэгдэж буй Telegram user ID-д администраторын гараар холбоос өгөх тусгай хэрэгцээнд хэвээр; команд ажиллуулах сервер болон MongoDB credentials-д зөвхөн администратор хандах ёстой.

```sh
npm run merchant:telegram:binding -- issue demo-prius-parts 123456789
npm run merchant:telegram:binding -- list
npm run merchant:telegram:binding -- revoke tb-BINDING_ID
```

`123456789` болон `tb-BINDING_ID` нь жишээ: бодит authorized user ID болон `list`-ийн binding ID-г хэрэглэнэ. CLI issue командын `/start TOKEN`-ийг зөвхөн заасан хэрэглэгчид хувийн сувгаар дамжуулна. Тэр хэрэглэгч ботын хувийн чатад командыг илгээнэ. CLI token 15 минут хүчинтэй, 32 byte санамсаргүй утгатай; MongoDB-д зөвхөн hash хадгална. Token-ийг өөр хэрэглэгч, өөр auth mode эсвэл давтан ашиглах боломжгүй. Dashboard token нь user ID-г урьдчилан шаардахгүй боловч demo merchant-аас үүссэн, 5 минутын, нэг удаагийн token байна. Private chat ID нь хэрэглэгчийн ID-тэй тэнцэх шаардлагатай; групп, суваг, бот хэрэглэгч rejected болно. Нэг mode-д нэг merchant болон нэг chat тус бүр нэг идэвхтэй binding-тай.

Numeric ID-г урьдчилан мэдэхгүй бол худалдаачин өөрийн ботод `/start` бичнэ. Ажиллагчийг зогсоож, webhook байхгүй үед администратор албан ёсны update-ийн `message.from.id`-г уншиж, худалдаачны identity-тэй тусад нь баталгаажуулна. Нууц token-ийг URL/command history-д оруулахын оронд одоогийн server adapter ашиглаж зөвхөн ID хэвлэх жишээ:

```powershell
node --conditions=react-server --import tsx --input-type=module -e '
import envModule from "@next/env";
import configModule from "./merchant/telegram/config.ts";
import apiModule from "./merchant/telegram/api.ts";
envModule.loadEnvConfig(process.cwd(), true, { info: () => {}, error: () => {} });
const api = new apiModule.TelegramBotAPI(configModule.readTelegramConfig().token);
for (const update of await api.getUpdates(0)) {
  if (update.message?.chat.type === "private") console.log(update.message.from.id);
}
'
```

Энэ уншилт binding үүсгэхгүй; администраторын issue алхам шаардлагатай. Revoke хийсний дараа хуучин callback, saved binding object, draft publication эрхгүй болно. Confirmation transaction binding record-д write хийдэг тул revocation race нь commit conflict-д орно.

## Монгол хариу, Gemini, баталгаажуулалт

Fixture-ийн `demo-prius-parts` худалдаачинд дараах бүрэн хариуг туршиж болно:

> Үйлдвэрийн бус шинэ урд гупер 650 мянган төгрөг, 1 ширхэг, одоо бэлэн.

Gemini response JSON-ийг `quoteDraftSchema`-аар strict validate хийнэ. Default `json` compatibility mode нь `application/json` MIME болон prompt-д portable schema заавар дамжуулна; сервер Zod-оор гаралтыг шалгана. Энэ горимд upstream SDK full schema enforcement хийсэн гэж үзэхгүй. `schema` opt-in нь nullable conversion хийсэн compact schema-г албан ёсны SDK `responseSchema`-д өгнө. Одоогийн загварын full quote schema upstream нийцэл баталгаажаагүй тул default болгон сонгоогүй.

`amountMinor` нь төгрөгийн үнэ × 100: 650000 төгрөг → 65000000. `condition=aftermarket`, `available=true`, warranty бичээгүй бол `null`. Засварын хариунд харуулсан боломжит `slotId`-г тодорхой сонгоно. Дутуу утгыг AI нөхөхгүй; Монгол тодруулах мэдээлэл харуулна. Урт RFQ болон preview-г 4000 тэмдэгтийн хэсгүүдээр бүтнээр нь харуулж, зөвхөн сүүлчийн хэсэгт confirmation товч байрлуулна. Preview хэсэг бүр RFQ reply link-тай хадгалагдана.

Хэлний extraction-д өөрийн худалдаачны public resource name/id/condition/warranty, request item болон боломжит slot metadata л орно. Stored prices, stock counts, minimum prices, discount settings, Buyer identity болон VIN prompt-д орохгүй. Merchant response ба RFQ доторх зааврыг өгөгдөл гэж авч үзнэ. AI quotation authorization хийхгүй. [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output) нь хэлбэрийн заавар; Zod болон deterministic business checks эцсийн баталгаажуулалт хийнэ.

Жишээ `280 мянга, хуучин, одоо бэлэн`-ийг extraction зөв таньсан ч тухайн merchant-ийн хадгалсан нөхцөлд нийцэхгүй бол confirmation rejected болно. Extraction амжилт нь үнийн санал нийтлэгдсэн гэсэн үг биш. Preview-д бүртгэлтэй warranty/customer-parts terms харуулж, эх сурвалжгүй нөхцөл нийтлэхээс хамгаална.

## Webhook горим

Endpoint: `POST /api/merchant-telegram/webhook`. Next.js route нь webhook mode, HTTPS, `X-Telegram-Bot-Api-Secret-Token` болон JSON content type-ийг DB/provider connection-оос өмнө шалгана. Body 64 KiB хязгаартай. Secret constant-time comparison ашиглана. Зөв secret байсан ч merchant binding болон update ownership дахин шалгагдана.

1. Бүх polling/outbox worker-ийг зогсооно. `TELEGRAM_MODE=webhook`, HTTPS URL, тусдаа webhook secret тохируулна.
2. Deployment HTTPS endpoint эсвэл локал tunnel ашиглана. Локал жишээ: Next.js-ийн 3000 порт руу `ngrok http 3000` ажиллуулаад олгосон HTTPS origin-ийн `/api/merchant-telegram/webhook` хаягийг хэрэглэнэ. Ngrok-ийн суулгалт болон account тохиргоо [албан ёсны зааварт](https://ngrok.com/docs/start) байна. Localtunnel мөн ижил HTTPS route дамжуулах боломжтой.
3. TLS termination proxy `x-forwarded-proto`-г өөрөө **солих** ёстой; untrusted client header-ийг нэмэж дамжуулж болохгүй. Route нь `https:` URL эсвэл яг `x-forwarded-proto: https` утгыг шалгана. Public plain HTTP портод шууд хандах замыг хаана.
4. Worker зогссон үед бүртгэнэ, дараа нь webhook-ийн **notification outbox** worker-ийг эхлүүлнэ:

```sh
npm run merchant:telegram:webhook -- register
npm run merchant:telegram:webhook -- status
npm run merchant:telegram:worker
```

Webhook mode worker update polling хийхгүй; зөвхөн durable notification outbox flush хийнэ. Webhook POST update-уудыг Next.js боловсруулна. Registration `allowed_updates=[message,callback_query]`, `max_connections=1`, `drop_pending_updates=false`, `secret_token` ашиглана. [Telegram setWebhook](https://core.telegram.org/bots/api#setwebhook)-ийн HTTPS болон secret header шаардлага мөрдөгдөнө.

Горим солихын өмнө worker-ийг зогсооно. Registration/removal CLI ижил maintenance lease авч polling эхлэх race-ийг хаана; идэвхтэй webhook request lease мөн polling start-ийг хаана. Webhook устгах:

```sh
npm run merchant:telegram:webhook -- remove
```

Дараа нь `TELEGRAM_MODE=polling`, webhook URL/secret хоосон болгож локал worker эхлүүлнэ. `status` команд token, URL, secret хэвлэхгүй; бүртгэлтэй эсэх, pending update тоо л хэвлэнэ. Validated update амжилттай эсвэл өмнө нь дууссан бол 200; active duplicate эсвэл түр DB/API алдаа бол retryable response өгнө. Production tunnel/webhook болон бодит Telegram delivery-ийн баталгаажуулалтын төлөвийг доорх тест хэсэгт тусад нь тэмдэглэнэ.

## Buyer-ийн additive A2A интеграци

RFQ/Quote v1 schema өөрчлөгдөөгүй. Шинэ action нь одоогийн A2A `SendMessage`-ийн data part дотор байна:

```json
{"contractVersion":"1","action":"get_quote_updates","rfqId":"rfq-1","afterRevision":1}
```

`merchantId` routing болон баталгаажсан `buyerId` token-оос гарна. Хүсэлтэд buyer/merchant override байхгүй. Сервер эхлээд persisted RFQ-ийн buyer ownership-ийг шалгаж, дараа нь scoped quote queries хийнэ. Wrong buyer/merchant дээр 403; invalid action fields дээр стандарт JSON-RPC invalid params. Authentication болон таван Agent Card хаяг [Phase 3](merchant-phase3.md)-тай адил. Card-д `quote-updates` skill нэмсэн; streaming/push notification advertise хийхгүй.

Албан ёсны SDK 1.3.0 / A2A 1.0 жишээ:

```ts
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { SendMessageRequest } from "@a2a-js/sdk";
import { quoteUpdatesResponseSchema } from "./merchant/telegram/contracts";

const authenticatedFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${verifiedBuyerToken}`);
  return fetch(input, { ...init, headers });
};
const client = await new ClientFactory({
  transports: [new JsonRpcTransportFactory({ fetchImpl: authenticatedFetch })],
}).createFromUrl(`${merchantOrigin}/api/a2a/demo-prius-parts/.well-known/agent-card.json`, "");
const message = await client.sendMessage(SendMessageRequest.fromJSON({
  message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{
    mediaType: "application/json",
    data: { contractVersion: "1", action: "get_quote_updates", rfqId: "rfq-1", afterRevision: 1 },
  }] },
}));
if (!("parts" in message) || message.parts[0]?.content?.$case !== "data") {
  throw new Error("Үнийн саналын шинэчлэлтийн бүтэц буруу байна.");
}
const updates = quoteUpdatesResponseSchema.parse(message.parts[0].content.value);
```

SDK-ийн decoded Message-ийг ашиглана; custom REST polling endpoint нэмээгүй. Тусгаарласан Buyer test adapter [merchant-buyer.ts](../tests/helpers/merchant-buyer.ts)-д байна. Production Buyer import/implementation нэмээгүй.

Response нь `contractVersion`, `action:"quote_updates"`, `merchantId`, `rfqId`, original `correlationId`, `latestRevision`, `quotes` агуулна. `quotes` нь `afterRevision`-оос өндөр revision-уудыг өсөх дарааллаар буцаана; шинэ саналгүй үед `[]`. Entry бүр `{quote: QuoteV1, source:"automatic"|"human_confirmed"}`. Засварын entry-д additive `serviceWindow:{startsAt,endsAt}` байж болно. Энэ нь confirmation үед сонгосон slot-ийн immutable snapshot; дараа нь slot edit хийсэн ч нийтлэгдсэн window өөрчлөгдөхгүй. Buyer нь Quote expiry/status-ийг шалгаж зөвхөн тохирох хамгийн шинэ саналыг сонгоно; window нь booking/reservation биш.

```json
{
  "contractVersion":"1",
  "action":"quote_updates",
  "merchantId":"demo-prius-parts",
  "rfqId":"rfq-1",
  "correlationId":"corr-rfq-1",
  "latestRevision":1,
  "quotes":[]
}
```

Хүний confirmation дараа `latestRevision=2`, revision 2 бүхий full v1 Quote entry `source:"human_confirmed"`-тай ирнэ. Revision 1 database record `superseded` болно. **Анхны RFQ-г яг хэвээр дахин илгээхэд Phase 3-ийн cached response хэвээр буцна**; хүний санал авахын тулд шинэ action-ийг ашиглана. Buyer боломжийн хязгаарт давтамжтай `get_quote_updates` дуудаж `afterRevision=latestRevision`-ээ хадгалж болно; A2A Task/SSE/push callback шинээр нэмээгүй.

Хүний шинэ саналын public response жишээ (ID болон огноо нь зөвхөн жишээ):

```json
{
  "contractVersion":"1", "action":"quote_updates",
  "merchantId":"demo-prius-parts", "rfqId":"rfq-1",
  "correlationId":"corr-rfq-1", "latestRevision":2,
  "quotes":[{
    "source":"human_confirmed",
    "quote":{
      "contractVersion":"1", "id":"hq-example", "merchantId":"demo-prius-parts",
      "createdAt":"2026-10-04T12:05:00Z", "rfqId":"rfq-1", "buyerId":"buyer-example",
      "revision":2, "kind":"parts", "mode":"simulated",
      "lines":[{
        "resourceId":"demo-prius-parts-bumper", "description":"Урд гупер",
        "quantity":1, "unitPrice":{"amountMinor":64000000,"currency":"MNT"}
      }],
      "total":{"amountMinor":64000000,"currency":"MNT"},
      "expiresAt":"2026-10-04T12:20:00Z", "availabilityCheckedAt":"2026-10-04T12:05:00Z",
      "reservation":false, "status":"offered",
      "terms":"ХҮН БАТАЛГААЖУУЛСАН ТУРШИЛТЫН ҮНИЙН САНАЛ. Энэ санал нөөц захиалахгүй."
    }
  }]
}
```

## MongoDB, хугацаа, давхардал

Нэмэлт collections: `merchant_telegram_invites`, `merchant_telegram_bindings`, `merchant_telegram_updates`, `merchant_telegram_notifications`, `merchant_telegram_drafts`, `merchant_telegram_conversations`, `merchant_telegram_sessions`, `merchant_telegram_message_links`, `merchant_telegram_transport`, `merchant_quote_publications`. Existing RFQ/Quote/audit collections хэвээр.

- Invites: tokenHash unique, Date expiresAt TTL; CLI default 15 минут, dashboard invite 5 минут. Authorization код expiry-г TTL cleanup-аас тусдаа шууд шалгана. Dashboard invite-ийн partial unique index нэг merchant/mode-д нэг ашиглагдаагүй холбоос хязгаарлана.
- Bindings: merchant/id unique; mode/chat болон mode/merchant дээр active partial unique index. Revoke metadata/audit хадгална.
- Update records: botKey/updateId unique; botKey нь bot token-ий SHA-256 identifier. Records 30 хоногийн Date TTL-тэй. Processing lease 2 минут, heartbeat 20 секунд; expired lease retry боломжтой. Хуучин lease completion шинэ эзэмшигчийг acknowledge хийхгүй.
- Conversations: raw Монгол хариу extraction-ийн өмнө scoped transaction-д хадгалагдана; Date expiresAt 30 хоног. Message/RFQ links мөн 30 хоног хадгалагдана. Draft/quote/publication/audit-д TTL байхгүй.
- Draft ID binding/updateId-ээс deterministic; ижил update дахин quote draft үүсгэхгүй. Ижил RFQ-д AI responses дараалалгүй дууссан ч хуучин update шинэ нооргийг supersede хийхгүй.
- Quote revisions `{merchantId,rfqId,revision}` unique; publication `{merchantId,rfqId,quoteRevision}` unique. Draft confirmation, quote supersession, publication болон audit нэг snapshot/majority transaction-д орно. Давхар confirmation хадгалсан Quote-ийг буцаана.
- Outbox RFQ transaction-д үүснэ. Binding байхгүй үед pending хэвээр retry; RFQ хугацаа дуусвал expired; Telegram permanent rejection failed болно. Notification нь binding ID/chat/message ID-тай хадгалагдана.

Telegram send болон MongoDB commit нь нэг distributed transaction биш. Network retry эсвэл send амжилттай боловч commit тасарсан үед **мэдэгдэл давтагдаж болно**: гадаад delivery нь at-least-once. Update dedupe болон draft/quote publication нь logical idempotency хангана. Exactly-once Telegram delivery гэж батлаагүй. Index initialization automatic build/import-ийн үед ажиллахгүй.

## Тест ба баталгаажуулалтын төлөв

```sh
npm run typecheck
npm run lint
npm test
npm run test:merchant:a2a
npm run test:merchant:telegram
npm run build
```

Mock тестүүд Telegram fetch/API болон Gemini structured responses ашиглана. Binding authorization, unauthorized users, cross-merchant attempts, notification routing, Монгол extraction, missing fields, business rules, confirmation/rejection/expiry, update/confirmation duplicates, lease ownership, webhook secret/body/TLS/configuration, worker exclusivity/shutdown болон audit rollback шалгана.

`test:merchant:telegram` нь `mongodb-memory-server`-ээр 127.0.0.1-д **өөрийн disposable replica set** үүсгэж persistence, transaction concurrency болон албан ёсны A2A SDK human quote delivery-г шалгана. Telegram/Gemini API нь энэ интеграцид mocked хэвээр. `.env`, teammate/shared URI эсвэл shared database name ашиглахгүй. Өмнөх optional `MERCHANT_TEST_MONGODB_URI` тестүүд зөвхөн disposable орчинд зориулагдсан; shared Atlas URI өгч болохгүй.

Бодит API smoke нь MongoDB-д холбогдохгүй, үнийн санал нийтлэхгүй, webhook өөрчлөхгүй, худалдаачинд мэдэгдэл илгээхгүй:

```sh
npm run merchant:phase4:smoke -- gemini
npm run merchant:phase4:smoke -- telegram
```

Сүүлчийн нийлсэн баталгаажуулалт:

- `npm run typecheck`: тэнцсэн.
- `npm run lint`: 0 алдаа; Buyer-ийн өмнө байсан 1 warning хэвээр, Buyer код өөрчлөгдөөгүй.
- `npm test`: 108 тэнцсэн, 0 алдаа, 4 алгасагдсан. Хоёр нь өмнөх external MongoDB suite (disposable URI тохируулаагүй), хоёр нь тусдаа ажиллуулсан локал A2A/Telegram интеграцийн suite.
- `npm run test:merchant:a2a`: 7 тэнцсэн.
- `npm run test:merchant:telegram`: 11 тэнцсэн; real disposable MongoDB transactions + official A2A SDK, mocked Telegram/Gemini.
- `npm run build`: тэнцсэн.
- Store focused unit tests: 10 тэнцсэн.
- **Бодит Gemini JSON mode smoke тэнцсэн**: Монгол Приусын хариу, 280000 төгрөг, хуучин төлөв, бэлэн эсэх, өөрийн resource ID зөв танигдсан. Одоо байгаа key/model өөрчлөгдөөгүй; MongoDB-д холбогдоогүй, Quote нийтлээгүй.

Бодит Gemini schema opt-in-д full quote schema HTTP 400 `INVALID_ARGUMENT` өгсөн; ижил загвар tiny JSON schema хүлээн авсан. Тодорхой offending property тогтоогоогүй тул upstream full schema enforcement баталгаажсан гэж үзэхгүй. Default JSON compatibility mode болон server-side strict Zod/business validation бодитоор шалгагдсан.

Telegram token тохируулаагүй тул бодит `getMe`, merchant delivery, long polling болон deployment/ngrok webhook smoke ажиллуулаагүй. Mock transport passes-ийг live Telegram success гэж үзэхгүй. Shared Atlas-ийн өмнөх TLS холболт энэ Phase-д засагдсан гэж батлаагүй.

## Өөрчлөгдсөн файлууд

Phase 4-ийн шинэ хэрэгжүүлэлт:

- `merchant/telegram/{api,config,contracts,extraction,validation,store,service,worker,webhook}.ts`
- `app/api/merchant-telegram/webhook/route.ts`
- `scripts/merchant-telegram-{binding,worker,webhook,local-test}.ts`
- `scripts/merchant-phase4-smoke.ts`
- `tests/merchant-telegram-{gemini,store,transport}.test.ts`
- `tests/merchant-telegram.integration.test.ts`
- `docs/merchant-phase4.md`, `docs/merchant-telegram.env.example`

Additive өөрчлөлтүүд:

- `merchant/a2a/{cards,contracts,service,store,transport}.ts`: skill, response union, retrieval action, атомик outbox.
- `merchant/server/{database,env,providers}.ts`: индексүүд, provider configuration aliases, structured Gemini request.
- `merchant/i18n.ts`: item preference-ийн Монгол label.
- `shared/merchant-contracts.ts`: internal audit action enum нэмэлт.
- `tests/helpers/merchant-buyer.ts`, `tests/merchant-a2a.test.ts`: additive action-ийн тусгаарласан тест клиент болон type narrowing.
- `docs/merchant-shared-contracts.md`, `package.json`: интеграцийн гэрээний тайлбар, ажиллуулах/тест команд.

Одоогийн checkout-ийн manifest шалгах: `git status --short`, `git diff --name-only`. [Shared contract нэмэлт](merchant-shared-contracts.md), [store](../merchant/telegram/store.ts), [business validation](../merchant/telegram/validation.ts), [runtime](../merchant/telegram/service.ts), [transport tests](../tests/merchant-telegram-transport.test.ts), [disposable integration](../tests/merchant-telegram.integration.test.ts) нь хэрэгжүүлэлтийн үндсэн лавлагаа.
