import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { NextRequest } from "next/server";
import { DELETE, GET, POST } from "../app/api/merchant-demo/telegram/route";
import { DEMO_COOKIE, demoConfig, issueDemoSession } from "../merchant/server/demo-auth";
import { closeMerchantConnection, initializeMerchantDatabase } from "../merchant/server/database";
import { seedDemoMerchants } from "../merchant/server/seed";
import { createTelegramRuntime } from "../merchant/telegram/service";
import { readTelegramConfig } from "../merchant/telegram/config";
import { TelegramMerchantStore } from "../merchant/telegram/store";
import type { AIProvider } from "../merchant/server/providers";
import type { TelegramAPI } from "../merchant/telegram/api";

test("authenticated dashboard connects, verifies /start, reports status and disconnects using disposable MongoDB", {
  timeout: 600000,
}, async () => {
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger", ip: "127.0.0.1" } });
  const environment = {
    NODE_ENV: process.env.NODE_ENV,
    MONGODB_URI: process.env.MONGODB_URI,
    MONGODB_DB: process.env.MONGODB_DB,
    MERCHANT_DEMO_ENABLED: process.env.MERCHANT_DEMO_ENABLED,
    MERCHANT_DEMO_ACCESS_KEY: process.env.MERCHANT_DEMO_ACCESS_KEY,
    MERCHANT_DEMO_SESSION_SECRET: process.env.MERCHANT_DEMO_SESSION_SECRET,
    MERCHANT_DEMO_ORIGIN: process.env.MERCHANT_DEMO_ORIGIN,
    MERCHANT_TELEGRAM_ENABLED: process.env.MERCHANT_TELEGRAM_ENABLED,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    MERCHANT_TELEGRAM_AUTH_MODE: process.env.MERCHANT_TELEGRAM_AUTH_MODE,
    MERCHANT_TELEGRAM_DEMO_ENABLED: process.env.MERCHANT_TELEGRAM_DEMO_ENABLED,
  };
  const originalFetch = globalThis.fetch;
  let client: MongoClient | undefined;
  try {
    Reflect.set(process.env, "NODE_ENV", "test");
    process.env.MONGODB_URI = replica.getUri();
    process.env.MONGODB_DB = "merchant_telegram_dashboard_disposable";
    process.env.MERCHANT_DEMO_ENABLED = "true";
    process.env.MERCHANT_DEMO_ACCESS_KEY = "disposable-dashboard-access-key-32chars";
    process.env.MERCHANT_DEMO_SESSION_SECRET = "disposable-dashboard-session-secret-32chars";
    process.env.MERCHANT_DEMO_ORIGIN = "http://localhost:3000";
    process.env.MERCHANT_TELEGRAM_ENABLED = "true";
    process.env.TELEGRAM_BOT_TOKEN = `123456:${"a".repeat(30)}`;
    process.env.MERCHANT_TELEGRAM_AUTH_MODE = "demo";
    process.env.MERCHANT_TELEGRAM_DEMO_ENABLED = "true";
    globalThis.fetch = async () => Response.json({ ok: true, result: { id: 123456, is_bot: true, username: "ShaminDemoBot" } });

    const config = demoConfig();
    const merchantId = "demo-prius-parts";
    const session = issueDemoSession(merchantId, config);
    const url = "http://localhost:3000/api/merchant-demo/telegram";
    const request = (method: string, authenticated = true, origin = config.origin) => new NextRequest(url, {
      method,
      headers: {
        ...(origin ? { origin } : {}),
        ...(authenticated ? { cookie: `${DEMO_COOKIE}=${session}` } : {}),
      },
    });

    assert.equal((await GET(request("GET", false))).status, 401);
    assert.equal((await POST(request("POST", false))).status, 401);
    assert.equal((await POST(request("POST", true, "http://attacker.example"))).status, 403);

    client = new MongoClient(replica.getUri());
    await client.connect();
    const db = client.db(process.env.MONGODB_DB);
    await initializeMerchantDatabase(db);
    await seedDemoMerchants(client, db);
    await closeMerchantConnection();

    const created = await POST(request("POST"));
    assert.equal(created.status, 200);
    const result = await created.json() as { deepLink: string };
    const deepLink = new URL(result.deepLink);
    assert.equal(deepLink.origin, "https://t.me");
    assert.equal(deepLink.pathname, "/ShaminDemoBot");
    const inviteToken = deepLink.searchParams.get("start");
    assert.match(inviteToken ?? "", /^[A-Za-z0-9_-]{43}$/);

    const telegramConfig = readTelegramConfig();
    const telegram: TelegramAPI = {
      async getMe() { return { id: 123456, is_bot: true, username: "ShaminDemoBot" }; },
      async deleteWebhook() {},
      async setWebhook() {},
      async getUpdates() { return []; },
      async sendMessage() { return { message_id: 1 }; },
      async answerCallbackQuery() {},
      async getWebhookInfo() { return { url: "", pending_update_count: 0 }; },
    };
    const ai: AIProvider = { async generate() { throw new Error("Unexpected AI request in connection flow test"); } };
    const runtime = createTelegramRuntime({ client, db, telegram, ai, config: telegramConfig });
    const store = new TelegramMerchantStore(client, db);
    await runtime.processUpdate({
      update_id: 1,
      message: { message_id: 1, from: { id: 151234 }, chat: { id: 151234, type: "private" }, text: `/start ${inviteToken}` },
    });
    assert.equal((await GET(request("GET"))).status, 200);
    assert.deepEqual(await (await GET(request("GET"))).json(), { connected: true });
    assert.equal((await POST(request("POST"))).status, 409);
    const otherSession = issueDemoSession("demo-japan-used", config);
    const otherStatus = await GET(new NextRequest(url, { headers: { cookie: `${DEMO_COOKIE}=${otherSession}` } }));
    assert.deepEqual(await otherStatus.json(), { connected: false });
    await runtime.processUpdate({
      update_id: 2,
      message: { message_id: 2, from: { id: 151235 }, chat: { id: 151235, type: "private" }, text: `/start ${inviteToken}` },
    });
    assert.equal((await store.getMerchantBinding(merchantId))?.userId, "151234");
    assert.equal(await store.getBinding("151235", "151235", "demo"), null);

    const disconnected = await DELETE(request("DELETE"));
    assert.equal(disconnected.status, 200);
    assert.deepEqual(await disconnected.json(), { connected: false });
    assert.deepEqual(await (await GET(request("GET"))).json(), { connected: false });
  } finally {
    globalThis.fetch = originalFetch;
    await closeMerchantConnection();
    await client?.close();
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await replica.stop();
  }
});
