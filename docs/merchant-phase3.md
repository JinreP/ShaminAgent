# Phase 3 — A2A худалдаачны агентууд

Энэ хэрэгжүүлэлт Next.js App Router, Phase 1-ийн RFQ/Quote schema, Phase 2-ийн merchant-scoped MongoDB collection, seed, dashboard-ийг дахин ашиглана. Buyer Agent-ийн код өөрчлөгдөөгүй. Үнийн санал хадгалсан бодит туршилтын өгөгдлөөс детерминистик байдлаар тооцогдоно; хиймэл оюун үнэ, нөөц зохиохгүй. Бүх таван худалдаачин, бараа, үйлчилгээ **туршилтын** өгөгдөлтэй.

## Протокол болон discovery

Албан ёсны `@a2a-js/sdk@1.3.0`, A2A **1.0**, JSON-RPC binding ашиглана. Албан ёсны `JsonRpcTransportHandler`, `DefaultRequestHandler`, `AgentExecutor`, `AgentCard`, Buyer талын `ClientFactory` ашигласан. Лавлах: [A2A 1.0 specification](https://a2a-protocol.org/v1.0.0/specification/), [албан ёсны TypeScript SDK](https://github.com/a2aproject/a2a-js).

Нийтийн жагсаалт: `GET /api/a2a/discovery`. Таван merchant ID:

- `demo-prius-parts` — сэлбэг
- `demo-japan-used` — хуучин сэлбэг
- `demo-oem-center` — үйлдвэрийн оригинал сэлбэг
- `demo-auto-care` — засвар
- `demo-quick-garage` — засвар

Merchant бүрийн бие даасан хаяг:

- Agent Card: `GET /api/a2a/{merchantId}/.well-known/agent-card.json`
- A2A endpoint: `POST /api/a2a/{merchantId}`

Card нь нийтийн боломжууд, зөвшөөрөгдсөн оролт/гаралтын төрөл, auth, протоколыг зарлана. Үнэ, stock, хувийн доод үнэ, хөнгөлөлтийн хязгаар, сул цаг нийтэд харагдахгүй. Discovery/Card MongoDB холболт шаардахгүй. Phase 2-ийн `/api/merchants/discovery` нь хадгалсан идэвхтэй нийтийн profile-ийг үргэлжлүүлэн буцаана; агент RFQ бүр дээр тухайн profile-ийн идэвх болон боломжийг шалгана.

`A2A-Version: 1.0`, `Content-Type: application/json`, `Authorization: Bearer <token>` шаардлагатай. A2A 0.3-ийн `message/send`, `kind: data` хэлбэрийг энэ endpoint зарлахгүй. `SendMessage` нь шууд `Message` буцаана. Task, streaming, push notification дэмжлэг зарлаагүй; тэдгээр үйлдэл стандарт A2A алдаа өгнө.

## Баталгаажуулалт

Нэмэлт тохиргооны жишээ: [merchant-a2a.env.example](merchant-a2a.env.example). Одоогийн MongoDB credentials болон `.env` өөрчлөгдөөгүй.

Локал demo: `MERCHANT_A2A_AUTH_MODE=demo`, `MERCHANT_A2A_DEMO_ENABLED=true`, loopback `MERCHANT_A2A_ORIGIN`, тусдаа 32+ тэмдэгт token, `MERCHANT_A2A_DEMO_BUYER_ID` шаардлагатай. Зөвхөн тохируулсан buyer ID-д таван туршилтын merchant хүрээ олгоно. Dashboard cookie/access key үүнд эрх олгохгүй. `NODE_ENV=production` үед demo auth үргэлж хаалттай.

Бодит орчин: `MERCHANT_A2A_AUTH_MODE=jwt`, HTTPS `MERCHANT_A2A_ORIGIN`, байгууллагын өөрийн `MERCHANT_A2A_JWKS_URI` (HTTPS), `MERCHANT_A2A_ISSUER`, `MERCHANT_A2A_AUDIENCE` тохируулна. RS256/ES256 signature, issuer, audience, exp, sub, iat (1 цагийн дотор), signed `buyer_id` болон `merchant_ids` шалгана. Token-г итгэмжлэгдсэн identity service олгох ёстой; энэ фаз token олгох үйлчилгээ хэрэгжүүлэхгүй. `merchant_ids` нь эрх олгосон ID-уудын массив. RFQ-ийн buyerId болон merchantId token-ийн buyer болон route-ийн merchant-тэй таарах ёстой. Client-аас ирсэн ID эсвэл tenant эрх олгохгүй.

## Нэмэлт shared гэрээ

`shared/merchant-contracts.ts` дахь RFQ, Quote-ийн v1 талбарууд өөрчлөгдөөгүй. `merchant/a2a/contracts.ts` дараах тусдаа strict Zod schema-г нэмсэн:

- `merchantRFQEnvelopeSchema`: `{contractVersion:"1", rfq:RFQ, expiresAt, correlationId}`. Шинэ RFQ-ийн status `received`; expiresAt нь createdAt-аас хойш. Хүсэлт 100 хүртэл item, 64 KiB хүртэл HTTP body байна. createdAt серверийн цагаас 60 секундээс илүү ирээдүйд байж болохгүй.
- `merchantRFQResponseSchema`: `{contractVersion:"1", merchantId, rfqId, correlationId, outcome, message, issues, quote?, serviceWindow?}`. Outcome: `quoted`, `partial`, `declined`, `expired`, `failed`. Зөвхөн quoted/partial үр дүнд Quote байна.
- Audit action enum-д `rfq_processed`, `rfq_failed` нэмэгдсэн. Existing enum утгууд хадгалагдсан. Buyer тал exhaustive switch ашиглаж байвал нэмэлт action-г хүлээн авах ёстой.

Toyota Prius 30-д `make:"Toyota", model:"Prius 30"` ашиглана. `model:"Prius"` бол 2009–2015 оныг заана. Бүртгэлийн compatibility болон merchant public capability хоёрыг шалгана. Үйлчилгээ/сэлбэгийн нэр Монгол эсвэл танигдах англи alias байж болно; хэрэглэгчид харагдах хариу Монгол байна. Сэлбэгийн дугаар өгсөн бол тухайн merchant-ийн яг хадгалсан дугаартай таарна. Preference нь бодит condition-тэй таарах ёстой.

## RFQ хүсэлтийн жишээ

Туршилтын token-ийн buyer ID `demo-buyer` байвал дараах body-г `POST /api/a2a/demo-prius-parts` руу дээрх headers-тай илгээнэ. Огноог одоогийн цагтай уялдуулж шинэчилнэ.

```json
{
  "jsonrpc": "2.0",
  "id": "request-1",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "message-1",
      "role": "ROLE_USER",
      "parts": [{
        "mediaType": "application/json",
        "data": {
          "contractVersion": "1",
          "correlationId": "correlation-1",
          "expiresAt": "2026-10-04T16:00:00Z",
          "rfq": {
            "contractVersion": "1",
            "id": "rfq-1",
            "merchantId": "demo-prius-parts",
            "buyerId": "demo-buyer",
            "createdAt": "2026-10-04T15:00:00Z",
            "kind": "parts",
            "vehicle": {"make": "Toyota", "model": "Prius 30", "year": 2012},
            "items": [{"description": "Урд гупер", "quantity": 1, "preference": "aftermarket"}],
            "status": "received"
          }
        }
      }]
    }
  }
}
```

Засварын жишээ: endpoint болон rfq.merchantId-г `demo-auto-care`, kind-г `repair`, item description-г `Гупер солих`, preference-ийг хасна. `Гэрэл солих`, `Гупер будах` дэмжигдэнэ. requiredBy өгсөн бол боломжит цагийн төгсгөл тэр хугацаанаас өмнө байх ёстой. Хадгалсан serviceIds, durationMinutes, slot status/capacity-г шалгаж earliest eligible window буцаана. Бүх үйлчилгээ нэг цонхонд багтах ёстой. Захиалагчийн авчирсан сэлбэгийн нөхцөлийг Quote.terms-д харуулна.

## Үнийн саналын хариу

JSON-RPC result нь `message` талбартай A2A SendMessageResponse байна. `message.parts[0].data` дотор shared response байрлана. Шинэ deterministic seed-ийн урд гуперийн жишээ (quote ID нь серверийн hash):

```json
{
  "jsonrpc": "2.0",
  "id": "request-1",
  "result": {
    "message": {
      "messageId": "server-message-id",
      "contextId": "server-context-id",
      "role": "ROLE_AGENT",
      "parts": [{"mediaType": "application/json", "data": {
        "contractVersion": "1", "merchantId": "demo-prius-parts", "rfqId": "rfq-1",
        "correlationId": "correlation-1", "outcome": "quoted",
        "message": "Үнийн санал бэлэн боллоо. Бараа, засварын цаг захиалаагүй.", "issues": [],
        "quote": {
          "contractVersion": "1", "id": "q-server-hash", "merchantId": "demo-prius-parts",
          "createdAt": "2026-10-04T15:00:01Z", "rfqId": "rfq-1", "buyerId": "demo-buyer",
          "revision": 1, "kind": "parts", "mode": "simulated",
          "lines": [{"resourceId": "demo-prius-parts-bumper", "description": "Урд гупер", "quantity": 1,
            "unitPrice": {"amountMinor": 65000000, "currency": "MNT"}}],
          "total": {"amountMinor": 65000000, "currency": "MNT"},
          "expiresAt": "2026-10-04T15:15:01Z", "availabilityCheckedAt": "2026-10-04T15:00:01Z",
          "reservation": false, "status": "offered",
          "terms": "ТУРШИЛТЫН ҮНИЙН САНАЛ. Бараа, засварын цаг захиалаагүй. Захиалга хийхээс өмнө боломжийг дахин шалгана. Урд гупер: 3 сарын баталгаа — туршилт"
        }
      }}]
    }
  }
}
```

MNT мөнгө shared v1-ийн minor unit convention-оор 100-д хуваагдана: `65000000` нь 650,000 төгрөг. Үнэ seed-ээс өөрчлөгдсөн бол хадгалсан шинэ үнэ буцаана. Quote нь 15 минут буюу RFQ expiresAt/requiredBy/засварын эхлэх цаг хүртэл хамгийн богино хугацаанд хүчинтэй.

## Алдааны жишээнүүд

Schema буруу эсвэл RFQ ID өөр өгөгдлөөр давхардвал HTTP 200 + стандарт JSON-RPC error:

```json
{"jsonrpc":"2.0","id":"request-1","error":{"code":-32602,"message":"Хүсэлтийн талбарууд буруу байна."}}
```

Нэвтрэлтгүй HTTP 401 (`WWW-Authenticate: Bearer`); зөвшөөрөгдөөгүй худалдаачин/худалдан авагч HTTP 403; auth config дутуу HTTP 503. Жишээ HTTP 403:

```json
{"error":{"code":"forbidden","message":"Хүсэлтийн худалдан авагч эсвэл худалдаачны хүрээ зөрж байна."}}
```

Өгөгдөл зөв боловч автомашин/нөөц/цаг тохирохгүй бол A2A Message-ийн data-д domain response ирнэ:

```json
{"contractVersion":"1","merchantId":"demo-auto-care","rfqId":"repair-1","correlationId":"repair-corr-1","outcome":"declined","message":"Хүссэн үйлчилгээнд тохирох сул цаг алга байна.","issues":[{"code":"no_repair_slot","message":"Хүссэн үйлчилгээнд тохирох сул цаг алга байна."}]}
```

Domain codes: `insufficient_stock`, `item_unavailable`, `unsupported_vehicle`, `unsupported_capability`, `no_repair_slot`, `merchant_rejected`, `rfq_expired`, `processing_error`. Хэсэгчилсэн саналд available quantity бүхий lines, боломжгүй itemIndex/issue ирнэ. Алдаа raw exception, credentials, хувийн үнийн floor, cross-merchant өгөгдөл агуулахгүй.

## MongoDB, давхардал, хадгалалт

`merchant_rfqs`, `merchant_quotes`, `merchant_audit_events` ашиглаж, `merchant_rfq_processing` collection нэмсэн. Шинэ collection-ийн unique `{merchantId,id}` индекс болон correlation lookup индексийг одоогийн `npm run merchant:db:init` команд үүсгэнэ. Индексийн migration-ийг зөвшөөрсөн өөрийн орчинд ажиллуулна; энэ Phase-ийн туршилт хамтын DB-д init/seed/drop хийгээгүй.

Нэг snapshot/majority transaction нь scoped RFQ, revision 1 Quote (байвал), rfq_received, quote_created, rfq_processed/rfq_failed audit болон response/cache-г хамтад нь хадгална. Бүх query merchantId хүрээтэй. Quote stock/slot-г өөрчлөхгүй. Validated processing failure мөн failed result болон audit-тай хадгалагдана. Existing shared RFQ enum-д failed байхгүй тул ийм RFQ-ийн status declined, processing record-ийн status failed байна.

Canonical payload hash нь correlation ID, expiresAt, buyer болон RFQ-г хамруулна. Яг ижил хүсэлтийг, зэрэгцээ ирсэн ч, нэг удаа commit хийнэ. Давтан хүсэлт анхны response/quote/revision/expiresAt-г буцаана. Quote-ийн хугацаа дууссан бол **шинэ RFQ ID** ашиглаж дахин үнийн санал авна. Existing RFQ/Quote-г processing cache-гүй үед дахин ашиглаж дарж бичихгүй. MongoDB холболт эсвэл commit бүтэлгүйтвэл санал буцаахгүй, safe failed response өгнө; энэ алдааг DB unavailable үед хадгалсан гэж үзэж болохгүй. Холболт сэргэхэд ижил RFQ-г дахин илгээж болно.

Replica set шаардлагатай. Өмнөх shared Atlas TLS холболтын асуудлыг энэ Phase өөрчлөхгүй; credentials, cluster, shared seed-д хүрээгүй. MongoDB downtime-ийг UI/A2A Mongolian аюулгүй мэдээллээр харуулна.

## Buyer хөгжүүлэгчийн SDK хэрэглээ ба тест

Тусгаарласан жишээ: `tests/helpers/merchant-buyer.ts`. Production Buyer талд import хийхгүйгээр өөрийн adapter-д албан ёсны SDK ClientFactory + JsonRpcTransportFactory ашиглах хэв маягийг авч болно. Card URL-аас `createFromUrl(cardURL, "")`, Bearer нэмдэг fetchImpl, `SendMessageRequest.fromJSON(...)` хэрэглэнэ. SDK `client.sendMessage()` нь decoded `Message | Task` буцаадаг тул raw JSON-RPC result wrapper дахин задлахгүй. `Message.parts[0].content` нь `$case: "data"` бол value-г `merchantRFQResponseSchema`-аар validate хийнэ.

```sh
npm run typecheck
npm run lint
npm test
npm run test:merchant:a2a
```

Сүүлчийн команд `mongodb-memory-server`-ээр өөрийн **127.0.0.1 disposable replica set** эхлүүлнэ. `.env`, MONGODB_URI, MONGODB_DB, MERCHANT_TEST_MONGODB_URI-г ашиглахгүй. Тестийн таван Card, жинхэнэ localhost HTTP, албан ёсны Buyer SDK, бүх merchant-specific price, schema/auth/scope, stock, автомашин, цаг, expiry, rejection, зэрэгцээ duplicate, persistent update/reconnect-ийг шалгана. Дуусахад зөвхөн өөрийн үүсгэсэн процесс/temp файлыг цэвэрлэнэ. Анхны ажиллуулалтад MongoDB binary download болон локал процесс ажиллуулах боломж хэрэгтэй. Хамтын MongoDB-г тестийн URI болгож өгөхгүй.

Ердийн `npm test` нь локал интеграцийн тестийг opt-in хүртэл алгасана. Өмнөх Phase 1/2 external MongoDB тестүүд disposable URI байхгүй бол алгасагдана. Telegram, negotiation execution, approvals/orders/bookings/payments/MCP болон Phase 4 эхлээгүй.

## Баталгаажуулалтын үр дүн

- `npm run typecheck`: амжилттай.
- `npm run lint`: 0 алдаа; Buyer-ийн `lib/buyer-store.ts:27` дахь өмнө байсан 1 warning хэвээр. Buyer файл өөрчлөгдөөгүй.
- `npm test`: 69 тэнцсэн, 0 алдаа, 3 алгасагдсан. Хоёр нь өмнөх external MongoDB тест (disposable URI тохируулаагүй), нэг нь тусад нь ажиллуулах локал A2A интеграцийн тест.
- `npm run test:merchant:a2a`: 7 тэнцсэн, 0 алдаа, 0 алгасагдсан. Local replica set дээр MongoDB persistence, concurrent duplicate, dashboard edit/reconnect болон failed processing/audit шалгасан.
- `npm run build`: амжилттай; гурван A2A route (endpoint, Card, discovery) Next.js route жагсаалтад бүртгэгдсэн.

Бодит shared Atlas холболт болон байгууллагын identity service-ийн JWKS руу end-to-end шалгалт хийгээгүй. Ажиллуулах орчинд A2A auth тохиргоо, зөвшөөрөгдсөн индексийн migration болон ажиллах replica-set холболт шаардлагатай. Өмнөх shared MongoDB TLS алдааг энэ Phase-д дахин шалгаагүй, зассан гэж үзэхгүй. Одоогийн deterministic засварын цагууд 2026-10-12–14 тул тэдгээрийн хугацаа өнгөрсний дараа dashboard-оор өөрийн туршилтын орчинд шинэ сул цаг оруулах шаардлагатай.

## Phase 3 өөрчлөгдсөн файлууд

Шинэ файлууд:

- `merchant/a2a/auth.ts`
- `merchant/a2a/cards.ts`
- `merchant/a2a/contracts.ts`
- `merchant/a2a/engine.ts`
- `merchant/a2a/service.ts`
- `merchant/a2a/store.ts`
- `merchant/a2a/transport.ts`
- `app/api/a2a/[merchantId]/route.ts`
- `app/api/a2a/[merchantId]/.well-known/agent-card.json/route.ts`
- `app/api/a2a/discovery/route.ts`
- `merchant/i18n.ts`
- `scripts/merchant-a2a-local-test.ts`
- `tests/helpers/merchant-buyer.ts`
- `tests/merchant-a2a.test.ts`
- `tests/merchant-a2a-store.test.ts`
- `tests/merchant-a2a-transport.test.ts`
- `tests/merchant-a2a.integration.test.ts`
- `tests/merchant-i18n.test.ts`
- `docs/merchant-phase3.md`
- `docs/merchant-a2a.env.example`

Нэмэлтээр зассан файлууд:

- `shared/merchant-contracts.ts` — audit enum-ийн нэмэлт
- `merchant/server/database.ts` — processing collection-ийн индекс
- `merchant/demo-merchants.ts`, `merchant/server/seed.ts` — нийтийн болон fixture-ийн Монгол текст
- `merchant/private-contracts.ts` — custom validation-ийн Монгол текст; талбарууд хэвээр
- `merchant/server/admin-store.ts`, `merchant/server/http.ts` — нийтийн мэдээлэл, admin input болон алдааны Монгол текст
- `app/merchant/dashboard.tsx` — labels, status, notification, legacy descriptive text
- `tests/merchant-phase2.test.ts` — Монгол fixture болон admin save validation
- `docs/merchant-shared-contracts.md` — Buyer хөгжүүлэгчид Phase 3 нэмэлтийг заах
- `package.json`, `package-lock.json` — албан ёсны A2A SDK, JOSE болон локал MongoDB test dependency/command

Өмнөх seed troubleshooting-ийн өөрчлөлтүүд, хэрэглэгчийн `.env.example` устгал хэвээр хадгалагдсан; тэдгээрийг Phase 3-ийн шинэ өөрчлөлт гэж тооцоогүй. Хамтын DB дээр seed/drop/reset хийгээгүй.
