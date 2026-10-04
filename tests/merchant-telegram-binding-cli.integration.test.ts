import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { seedDemoMerchants } from "../merchant/server/seed";
import { TelegramMerchantStore } from "../merchant/telegram/store";

test("Telegram binding CLI loads explicit environment, lists bindings and issues only disposable invites", {
  skip: process.env.MERCHANT_TELEGRAM_BINDING_CLI_INTEGRATION !== "true",
  timeout: 600000,
}, async () => {
  const replica = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger", ip: "127.0.0.1" },
  });
  const dbName = "telegram_binding_cli_disposable";
  const setupClient = new MongoClient(replica.getUri());
  const cliEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: "test",
    MONGODB_URI: replica.getUri(),
    MONGODB_DB: dbName,
    MERCHANT_TELEGRAM_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz_test_token",
    MERCHANT_TELEGRAM_AUTH_MODE: "demo",
    MERCHANT_TELEGRAM_DEMO_ENABLED: "true",
  };

  function runCli(...args: string[]) {
    const result = spawnSync(process.execPath, [
      "--conditions=react-server", "--import", "tsx", "scripts/merchant-telegram-binding.ts", ...args,
    ], { cwd: process.cwd(), env: cliEnv, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    return result;
  }

  try {
    await setupClient.connect();
    const db = setupClient.db(dbName);
    await seedDemoMerchants(setupClient, db);

    const emptyList = runCli("list");
    assert.equal(emptyList.status, 0, emptyList.stderr);
    assert.deepEqual(JSON.parse(emptyList.stdout), []);

    const badUserId = runCli("issue", "demo-prius-parts", "TELEGRAM_USER_ID");
    assert.notEqual(badUserId.status, 0);
    assert.match(badUserId.stderr, /зөвхөн тооноос бүрдэх/);
    assert.equal(await db.collection("merchant_telegram_invites").countDocuments({}), 0);

    const testUserId = "987654321012345";
    const issued = runCli("issue", "demo-prius-parts", testUserId);
    assert.equal(issued.status, 0, issued.stderr);
    const match = /\/start ([A-Za-z0-9_-]{43})/.exec(issued.stdout);
    assert.ok(match, "CLI should generate a valid one-time Telegram start token");
    const invitationToken = match[1];
    assert.equal(issued.stdout.includes(replica.getUri()), false);
    assert.equal(issued.stdout.includes(cliEnv.TELEGRAM_BOT_TOKEN!), false);
    const invite = await db.collection("merchant_telegram_invites").findOne({
      merchantId: "demo-prius-parts", userId: testUserId, mode: "demo", consumed: false,
    });
    assert.ok(invite);
    assert.equal(invite.tokenHash, createHash("sha256").update(JSON.stringify(invitationToken)).digest("hex"));

    const verificationClient = new MongoClient(replica.getUri());
    try {
      await verificationClient.connect();
      const store = new TelegramMerchantStore(verificationClient, verificationClient.db(dbName));
      const binding = await store.bind(invitationToken, testUserId, testUserId, "demo");
      assert.equal(binding.merchantId, "demo-prius-parts");
    } finally {
      await verificationClient.close();
    }

    const listed = runCli("list");
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), [{
      id: (await db.collection("merchant_telegram_bindings").findOne({
        merchantId: "demo-prius-parts", userId: testUserId, mode: "demo", active: true,
      }))?.id,
      merchantId: "demo-prius-parts",
      userId: testUserId,
      mode: "demo",
    }]);
    assert.equal(listed.stdout.includes(invitationToken), false);
  } finally {
    await setupClient.close();
    await replica.stop();
  }
});
