import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "mongodb";
import { readTelegramConfig, type TelegramConfig } from "../merchant/telegram/config";
import { TelegramBotAPI, TelegramAPIError, type TelegramAPI } from "../merchant/telegram/api";
import { handleTelegramWebhook, validateWebhookSecret } from "../merchant/telegram/webhook";
import { acquireTelegramAdministrationLease, acquireTelegramLease, releaseTelegramLease, runTelegramWorker, TelegramTransportConflict, withTelegramWebhookLease } from "../merchant/telegram/worker";
import type { TelegramUpdate } from "../merchant/telegram/contracts";

const token = `123456:${"a".repeat(30)}`, secret = "s".repeat(40);
const environment = { MERCHANT_TELEGRAM_ENABLED: "true", TELEGRAM_BOT_TOKEN: token };
function config(mode: "polling" | "webhook" = "polling"): TelegramConfig {
  return readTelegramConfig({ ...environment, TELEGRAM_MODE: mode,
    ...(mode === "webhook" ? { TELEGRAM_WEBHOOK_URL: "https://merchant.example/api/merchant-telegram/webhook", TELEGRAM_WEBHOOK_SECRET: secret } : {}) });
}
function fakeDb() {
  type State = { _id: string; owner: string; mode: string; leaseUntil: Date; offset: number; webhookRequests?: { id: string; until: Date }[] };
  let state: State | undefined;
  const collection = {
    async findOneAndUpdate(filter: { _id: string; $or?: { leaseUntil?: { $lte: Date }; owner?: string; mode?: string }[];
      $and?: [{ $or: { leaseUntil?: { $lte: Date }; owner?: string; mode?: string }[] }, { webhookRequests: { $not: { $elemMatch: { until: { $gt: Date } } } } }] }, mutation: {
      $set: Partial<State>; $setOnInsert: Partial<State>; $push?: { webhookRequests: { id: string; until: Date } };
    }) {
      const alternatives = filter.$or ?? filter.$and?.[0].$or ?? [];
      const requestDeadline = filter.$and?.[1].webhookRequests.$not.$elemMatch.until.$gt;
      if (state && (!alternatives.some(condition => (condition.owner !== undefined && condition.owner === state!.owner) ||
          (condition.mode !== undefined && condition.mode === state!.mode) ||
          (condition.leaseUntil && state!.leaseUntil <= condition.leaseUntil.$lte)) ||
          (requestDeadline && state.webhookRequests?.some(request => request.until > requestDeadline)))) {
          throw { code: 11000 };
      }
      state = { _id: filter._id, owner: "", mode: "", leaseUntil: new Date(0), offset: 0,
        ...(!state ? mutation.$setOnInsert : state), ...mutation.$set };
      if (mutation.$push) (state.webhookRequests ??= []).push(mutation.$push.webhookRequests);
      return state;
    },
    async updateOne(filter: { _id: string; owner?: string; leaseUntil?: { $gt: Date } }, mutation: {
      $set?: Partial<State>; $pull?: { webhookRequests: { id?: string; until?: { $lte: Date } } };
    }) {
      const matches = Boolean(state && state._id === filter._id && (!filter.owner || state.owner === filter.owner) &&
        (!filter.leaseUntil || state.leaseUntil > filter.leaseUntil.$gt));
      if (matches && mutation.$set) Object.assign(state!, mutation.$set);
      if (matches && mutation.$pull) state!.webhookRequests = state!.webhookRequests?.filter(request =>
        mutation.$pull!.webhookRequests.id ? request.id !== mutation.$pull!.webhookRequests.id :
          request.until > mutation.$pull!.webhookRequests.until!.$lte);
      return { matchedCount: matches ? 1 : 0 };
    },
    async findOne(filter: { _id: string; mode: string; leaseUntil: { $gt: Date } }) {
      return state && state._id === filter._id && state.mode === filter.mode && state.leaseUntil > filter.leaseUntil.$gt ? state : null;
    },
  };
  return { db: { collection: () => collection } as unknown as Db, state: () => state };
}
function mockApi(overrides: Partial<TelegramAPI> = {}): TelegramAPI {
  return {
    getMe: async () => ({ id: 1, is_bot: true }), deleteWebhook: async () => {}, setWebhook: async () => {},
    getUpdates: async () => [], sendMessage: async () => ({ message_id: 1 }), answerCallbackQuery: async () => {},
    getWebhookInfo: async () => ({ url: "", pending_update_count: 0 }), ...overrides,
  };
}
function webhookRequest(body: unknown = { update_id: 1 }, supplied = secret, url = "https://merchant.example/api/merchant-telegram/webhook") {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": supplied },
    body: JSON.stringify(body) });
}

test("Telegram configuration defaults polling, keeps credentials server-side and requires explicit opt-in", () => {
  const value = readTelegramConfig(environment);
  assert.equal(value.mode, "polling"); assert.equal(value.merchantAuthMode, "production");
  assert.equal(value.botKey.length, 64); assert.ok(!value.botKey.includes(token));
  assert.throws(() => readTelegramConfig({ TELEGRAM_BOT_TOKEN: token }), /MERCHANT_TELEGRAM_ENABLED/);
  assert.throws(() => readTelegramConfig({ ...environment, TELEGRAM_BOT_TOKEN: "private-credential" }), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes("private-credential")); return true;
  });
});
test("Telegram rejects polling/webhook conflicts, insecure endpoints and production demo authentication", () => {
  assert.throws(() => readTelegramConfig({ ...environment, TELEGRAM_WEBHOOK_URL: "https://example.test" }), /TELEGRAM_WEBHOOK_URL/);
  assert.throws(() => readTelegramConfig({ ...environment, TELEGRAM_MODE: "webhook", TELEGRAM_WEBHOOK_URL: "http://localhost:3000", TELEGRAM_WEBHOOK_SECRET: secret }), /TELEGRAM_WEBHOOK_URL/);
  assert.throws(() => readTelegramConfig({ ...environment, TELEGRAM_MODE: "webhook", TELEGRAM_WEBHOOK_URL: "https://example.test", TELEGRAM_WEBHOOK_SECRET: "short" }), /TELEGRAM_WEBHOOK_SECRET/);
  assert.throws(() => readTelegramConfig({ ...environment, MERCHANT_TELEGRAM_AUTH_MODE: "demo" }), /MERCHANT_TELEGRAM_AUTH_MODE/);
  assert.throws(() => readTelegramConfig({ ...environment, MERCHANT_TELEGRAM_AUTH_MODE: "demo", MERCHANT_TELEGRAM_DEMO_ENABLED: "true", NODE_ENV: "production" }), /MERCHANT_TELEGRAM_AUTH_MODE/);
  assert.equal(readTelegramConfig({ ...environment, MERCHANT_TELEGRAM_AUTH_MODE: "demo", MERCHANT_TELEGRAM_DEMO_ENABLED: "true", NODE_ENV: "development" }).merchantAuthMode, "demo");
});
test("Bot API uses genuine long polling and preserves pending updates when changing transport", async () => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const api = new TelegramBotAPI(token, { fetch: async (input, init) => {
    const method = String(input).split("/").at(-1)!;
    calls.push({ method, body: JSON.parse(String(init?.body)) });
    assert.ok(init?.signal);
    return Response.json({ ok: true, result: method === "getUpdates" ? [{ update_id: 8 }] : true });
  } });
  assert.deepEqual(await api.getUpdates(8), [{ update_id: 8 }]);
  await api.deleteWebhook(); await api.setWebhook(config("webhook").webhookUrl!, secret);
  assert.deepEqual(calls[0], { method: "getUpdates", body: { offset: 8, timeout: 30, limit: 100, allowed_updates: ["message", "callback_query"] } });
  assert.equal(calls[1].body.drop_pending_updates, false); assert.equal(calls[2].body.drop_pending_updates, false);
  assert.equal(calls[2].body.secret_token, secret);
});
test("Bot API handles 429 retry_after and bounded transient retries without exposing provider strings", async () => {
  const waits: number[] = [];
  let requests = 0;
  const api = new TelegramBotAPI(token, { wait: async ms => { waits.push(ms); }, fetch: async () => {
    requests++;
    return requests === 1 ? Response.json({ ok: false, error_code: 429, description: token, parameters: { retry_after: 2 } }, { status: 429 })
      : Response.json({ ok: true, result: { message_id: 42 } });
  } });
  assert.deepEqual(await api.sendMessage("100", "Шинэ хүсэлт ирлээ."), { message_id: 42 });
  assert.deepEqual(waits, [2000]); assert.equal(requests, 2);
  let failedRequests = 0;
  const failing = new TelegramBotAPI(token, { wait: async () => {}, fetch: async () => {
    failedRequests++; throw new Error(`https://api.telegram.org/bot${token}/getMe`);
  } });
  await assert.rejects(() => failing.getMe(), error => {
    assert.ok(error instanceof TelegramAPIError); assert.match(error.message, /[А-Яа-яӨөҮү]/); assert.ok(!error.message.includes(token)); return true;
  });
  assert.equal(failedRequests, 3);
});
test("Bot API forwards native Mongolian inline buttons and aborts cancelled polling", async () => {
  const controller = new AbortController();
  let calls = 0;
  const buttons = { inline_keyboard: [[{ text: "Баталгаажуулах", callback_data: "confirm:draft-1" }]] };
  const api = new TelegramBotAPI(token, { fetch: async (_input, init) => {
    calls++; const body = JSON.parse(String(init?.body)); assert.deepEqual(body.reply_markup, buttons);
    return Response.json({ ok: true, result: { message_id: 3 } });
  } });
  await api.sendMessage("1", "Үнийн саналаа шалгана уу.", buttons);
  controller.abort(); await assert.rejects(() => api.getUpdates(0, controller.signal)); assert.equal(calls, 1);
});
test("Webhook validates the secret in constant time and rejects malformed or oversized requests", async () => {
  assert.equal(validateWebhookSecret(secret, secret), true); assert.equal(validateWebhookSecret(secret + "x", secret), false);
  assert.equal(validateWebhookSecret(null, secret), false); assert.equal(validateWebhookSecret("x".repeat(300), secret), false);
  const database = fakeDb(), processed: TelegramUpdate[] = [];
  const dependencies = { config: config("webhook"), db: database.db,
    runtime: { processUpdate: async (update: TelegramUpdate) => { processed.push(update); }, flushNotifications: async () => {} } };
  assert.equal((await handleTelegramWebhook(webhookRequest(undefined, "wrong"), dependencies)).status, 401);
  assert.equal((await handleTelegramWebhook(webhookRequest(undefined, secret, "http://merchant.example"), dependencies)).status, 400);
  assert.equal((await handleTelegramWebhook(webhookRequest({ update_id: "wrong" }), dependencies)).status, 400);
  assert.equal((await handleTelegramWebhook(webhookRequest({ update_id: 1, oversized: "x".repeat(65536) }), dependencies)).status, 413);
  assert.equal(processed.length, 0);
  assert.equal((await handleTelegramWebhook(webhookRequest({ update_id: 8 }), dependencies)).status, 200);
  assert.deepEqual(processed, [{ update_id: 8 }]);
});
test("Next webhook route rejects unauthorized requests before loading MongoDB or AI runtime", async () => {
  const source: Record<string, string> = { ...environment, TELEGRAM_MODE: "webhook",
    TELEGRAM_WEBHOOK_URL: "https://merchant.example/api/merchant-telegram/webhook", TELEGRAM_WEBHOOK_SECRET: secret,
    MERCHANT_TELEGRAM_AUTH_MODE: "production", MONGODB_URI: "", MONGODB_DB: "" };
  const saved = Object.fromEntries(Object.keys(source).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, source);
    const { POST } = await import("../app/api/merchant-telegram/webhook/route");
    // A database/runtime initialization attempt would return503 with the deliberately absent database configuration.
    assert.equal((await POST(webhookRequest(undefined, "invalid-secret"))).status, 401);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
test("Webhook returns retryable failure and refuses a currently running polling worker", async () => {
  const database = fakeDb();
  await acquireTelegramLease(database.db, config(), "poller");
  let processed = false;
  const dependencies = { config: config("webhook"), db: database.db,
    runtime: { processUpdate: async () => { processed = true; }, flushNotifications: async () => {} } };
  assert.equal((await handleTelegramWebhook(webhookRequest(), dependencies)).status, 409); assert.equal(processed, false);
  await releaseTelegramLease(database.db, config(), "poller");
  dependencies.runtime.processUpdate = async () => { throw new Error(token); };
  const failure = await handleTelegramWebhook(webhookRequest(), dependencies);
  assert.equal(failure.status, 503); assert.ok(!(await failure.text()).includes(token));
});
test("Persistent transport lease refuses a second worker and preserves the polling offset", async () => {
  const database = fakeDb(), configuration = config();
  assert.equal(await acquireTelegramLease(database.db, configuration, "first"), 0);
  await assert.rejects(() => acquireTelegramLease(database.db, configuration, "second"), TelegramTransportConflict);
  database.state()!.offset = 5;
  await releaseTelegramLease(database.db, configuration, "first");
  assert.equal(await acquireTelegramLease(database.db, configuration, "second"), 5);
});
test("An in-flight webhook blocks polling even when its outbox worker stops", async () => {
  const database = fakeDb(), webhook = config("webhook"), polling = config();
  await acquireTelegramLease(database.db, webhook, "outbox");
  await withTelegramWebhookLease(database.db, webhook, async () => {
    await releaseTelegramLease(database.db, webhook, "outbox");
    await assert.rejects(() => acquireTelegramLease(database.db, polling, "poller"), TelegramTransportConflict);
    await assert.rejects(() => acquireTelegramAdministrationLease(database.db, webhook, "administrator"), TelegramTransportConflict);
    assert.equal(await acquireTelegramLease(database.db, webhook, "new-outbox"), 0);
    await releaseTelegramLease(database.db, webhook, "new-outbox");
  });
  assert.equal(await acquireTelegramLease(database.db, polling, "poller"), 0);
});
test("Webhook registration/removal lock prevents incoming requests during the mode change", async () => {
  const database = fakeDb(), webhook = config("webhook");
  await acquireTelegramAdministrationLease(database.db, webhook, "administrator");
  assert.equal(database.state()?.mode, "maintenance");
  await assert.rejects(() => withTelegramWebhookLease(database.db, webhook, async () => {}), TelegramTransportConflict);
  await assert.rejects(() => acquireTelegramLease(database.db, webhook, "worker"), TelegramTransportConflict);
  await releaseTelegramLease(database.db, webhook, "administrator");
  await withTelegramWebhookLease(database.db, webhook, async () => {});
});
test("Polling only acknowledges updates after successful processing and shuts down gracefully", async () => {
  const database = fakeDb(), shutdown = new AbortController(), offsets: number[] = [], processed: number[] = [];
  let removedWebhook = false, processingAttempt = 0;
  const api = mockApi({ deleteWebhook: async () => { removedWebhook = true; }, getUpdates: async offset => {
    offsets.push(offset); assert.ok(removedWebhook);
    if (offset >= 7) { shutdown.abort(); return []; }
    return [{ update_id: 4 }, { update_id: 6 }];
  } });
  await runTelegramWorker({ db: database.db, config: config(), telegram: api, signal: shutdown.signal, idleMs: 1, logger: () => {},
    runtime: { flushNotifications: async () => {}, processUpdate: async update => {
      processingAttempt++;
      if (processingAttempt === 1) throw new Error("temporary failure");
      processed.push(update.update_id);
    } } });
  assert.deepEqual(offsets, [0, 0, 7]); assert.deepEqual(processed, [4, 6]); assert.equal(database.state()?.offset, 7);
  assert.equal(database.state()?.leaseUntil.getTime(), 0);
});
test("Webhook notification worker never polls or deletes the remote webhook", async () => {
  const database = fakeDb(), shutdown = new AbortController();
  await runTelegramWorker({ db: database.db, config: config("webhook"), signal: shutdown.signal, idleMs: 1, logger: () => {},
    telegram: mockApi({ getUpdates: async () => { assert.fail("webhook worker must not poll"); },
      deleteWebhook: async () => { assert.fail("webhook worker must not delete webhook"); } }),
    runtime: { processUpdate: async () => {}, flushNotifications: async () => { shutdown.abort(); } } });
  assert.equal(database.state()?.mode, "webhook"); assert.equal(database.state()?.leaseUntil.getTime(), 0);
});
