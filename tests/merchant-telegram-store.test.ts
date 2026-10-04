import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db, Document, MongoClient } from "mongodb";
import { demoSeedRecords } from "../merchant/server/seed";
import { MongoRFQStore } from "../merchant/a2a/store";
import { calculateMerchantRFQ } from "../merchant/a2a/engine";
import type { MerchantRFQEnvelope } from "../merchant/a2a/contracts";
import { TelegramMerchantStore, TelegramStoreError, telegramCollections } from "../merchant/telegram/store";
import { validateHumanQuote } from "../merchant/telegram/validation";
import type { QuoteDraft } from "../merchant/telegram/contracts";

// Unit test double verifies failure rollback and scope predicates. Replica-set concurrency is tested separately.
function fixtureMongo() {
  let collections: Record<string, Document[]> = {};
  let failingAction = "";
  const comparison = (a: unknown, b: unknown): number => {
    if (a === b) return 0;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    const left = a instanceof Date ? a.getTime() : a as string | number;
    const right = b instanceof Date ? b.getTime() : b as string | number;
    return left < right ? -1 : left > right ? 1 : 0;
  };
  const matches = (record: Document, filter: Document): boolean => Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some((part: Document) => matches(record, part));
    if (value && typeof value === "object" && !(value instanceof Date)) return Object.entries(value).every(([operator, operand]) =>
      operator === "$gt" ? comparison(record[key], operand) > 0 : operator === "$lte" ? comparison(record[key], operand) <= 0 : operator === "$exists" ? (key in record) === operand : false);
    return comparison(record[key], value) === 0;
  });
  const update = (record: Document, changes: Document, inserted = false) => {
    Object.assign(record, changes.$set ?? {}, inserted ? changes.$setOnInsert ?? {} : {});
    for (const [key, value] of Object.entries(changes.$inc ?? {})) record[key] = (record[key] ?? 0) + Number(value);
    for (const key of Object.keys(changes.$unset ?? {})) delete record[key];
  };
  const db = { collection(name: string) {
    const rows = () => collections[name] ??= [];
    return {
      createIndexes: async () => {},
      findOne: async (filter: Document) => structuredClone(rows().find(row => matches(row, filter)) ?? null),
      find: (filter: Document) => {
        let ordering: Document = {}, max = Infinity;
        const cursor = { sort: (order: Document) => { ordering = order; return cursor; }, limit: (count: number) => { max = count; return cursor; },
          toArray: async () => structuredClone(rows().filter(row => matches(row, filter)).sort((a, b) => {
            for (const [key, direction] of Object.entries(ordering)) { const order = comparison(a[key], b[key]) * Number(direction); if (order) return order; }
            return 0;
          }).slice(0, max)) };
        return cursor;
      },
      insertOne: async (record: Document) => {
        if (record.action === failingAction) throw new Error("Injected audit failure");
        const collision = rows().some(row => row.id === record.id && row.merchantId === record.merchantId) ||
          (name === telegramCollections.bindings && rows().some(row => row.active && record.active && row.mode === record.mode && (row.chatId === record.chatId || row.merchantId === record.merchantId)));
        if (collision) throw Object.assign(new Error("duplicate"), { code: 11000 });
        rows().push(structuredClone(record)); return { insertedId: record.id };
      },
      updateOne: async (filter: Document, changes: Document, options?: Document) => {
        let record = rows().find(row => matches(row, filter));
        if (!record && options?.upsert) { record = { ...filter }; update(record, changes, true); rows().push(record); return { matchedCount: 0, upsertedCount: 1 }; }
        if (!record) return { matchedCount: 0, upsertedCount: 0 };
        update(record, changes); return { matchedCount: 1, upsertedCount: 0 };
      },
      updateMany: async (filter: Document, changes: Document) => { const matched = rows().filter(row => matches(row, filter)); matched.forEach(row => update(row, changes)); return { matchedCount: matched.length }; },
      findOneAndUpdate: async (filter: Document, changes: Document, options?: Document) => {
        const record = rows().find(row => matches(row, filter)); if (!record) return null;
        const before = structuredClone(record); update(record, changes); return structuredClone(options?.returnDocument === "after" ? record : before);
      },
    };
  } } as unknown as Db;
  const client = { startSession: () => ({ withTransaction: async (work: () => Promise<unknown>) => {
    const before = structuredClone(collections);
    try { return await work(); } catch (error) { collections = before; throw error; }
  }, endSession: async () => {} }) } as unknown as MongoClient;
  for (const { resource, record } of demoSeedRecords()) {
    const name = { profile: "merchant_profiles", inventory: "merchant_inventory", service: "merchant_services", slot: "merchant_slots", settings: "merchant_settings" }[resource];
    (collections[name] ??= []).push(structuredClone(record));
  }
  return { db, client, store: new TelegramMerchantStore(client, db), rows: (name: string) => collections[name] ?? [], failAudit: (action: string) => { failingAction = action; } };
}
function envelope(merchantId: string, id: string): MerchantRFQEnvelope {
  return { contractVersion: "1", correlationId: `corr-${id}`, expiresAt: new Date(Date.now() + 3600000).toISOString(),
    rfq: { contractVersion: "1", id, merchantId, buyerId: "test-buyer", createdAt: new Date(Date.now() - 1000).toISOString(), kind: "parts",
      vehicle: { make: "Toyota", model: "Prius 30", year: 2012 }, items: [{ description: "Урд гупер", quantity: 1 }], status: "received" } };
}
function draft(merchantId = "demo-prius-parts"): QuoteDraft {
  return { lines: [{ itemIndex: 0, resourceId: `${merchantId}-bumper`, quantity: 1,
    unitPrice: { amountMinor: 65000000, currency: "MNT" }, condition: "aftermarket", available: true, warranty: null }], slotId: null };
}
async function registered(fixture: ReturnType<typeof fixtureMongo>, merchantId = "demo-prius-parts", userId = "101") {
  const invite = await fixture.store.issueInvite(merchantId, userId, "demo", "test-admin");
  const binding = await fixture.store.bind(invite.token, userId, userId, "demo");
  return { invite, binding };
}
async function received(fixture: ReturnType<typeof fixtureMongo>, merchantId = "demo-prius-parts", id = "rfq-1", kind: "parts" | "repair" = "parts") {
  const input = envelope(merchantId, id);
  if (kind === "repair") { input.rfq.kind = "repair"; input.rfq.items[0].description = "Гупер солих"; }
  await new MongoRFQStore(fixture.client, fixture.db).processOnce(merchantId, "test-buyer", input,
    (data, now) => calculateMerchantRFQ(merchantId, input, data, now));
  return input;
}

test("administrator invites are hash-only, target one user and mode, expire and cannot be reused", async () => {
  const f = fixtureMongo(); const invite = await f.store.issueInvite("demo-prius-parts", "101", "demo", "test-admin");
  const persisted = f.rows(telegramCollections.invites)[0];
  assert.match(invite.token, /^[A-Za-z0-9_-]{43}$/); assert.match(persisted.tokenHash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(persisted).includes(invite.token));
  await assert.rejects(f.store.bind(invite.token, "102", "102", "demo"), TelegramStoreError);
  await assert.rejects(f.store.bind(invite.token, "101", "101", "production"), TelegramStoreError);
  await assert.rejects(f.store.bind(invite.token, "-100123", "101", "demo"), TelegramStoreError);
  assert.equal(persisted.consumed, false);
  const binding = await f.store.bind(invite.token, "101", "101", "demo"); assert.equal(binding.merchantId, "demo-prius-parts");
  await assert.rejects(f.store.bind(invite.token, "101", "101", "demo"), TelegramStoreError);
  const expired = await f.store.issueInvite("demo-japan-used", "102", "demo", "test-admin");
  f.rows(telegramCollections.invites).find(row => row.id === expired.id)!.expiresAt = new Date(Date.now() - 1);
  await assert.rejects(f.store.bind(expired.token, "102", "102", "demo"), TelegramStoreError);
});
test("dashboard Telegram invitations are merchant-scoped, one-time, short-lived and disconnectable", async () => {
  const f = fixtureMongo();
  const first = await f.store.issueDashboardInvite("demo-prius-parts", "demo-prius-parts");
  const firstRecord = f.rows(telegramCollections.invites).find(row => row.id === first.id)!;
  assert.equal(firstRecord.userId, null);
  assert.equal(firstRecord.dashboardInvite, true);
  assert.equal(firstRecord.expiresAt.getTime() - Date.now() <= 5 * 60000, true);
  assert.ok(!JSON.stringify(firstRecord).includes(first.token));

  const invite = await f.store.issueDashboardInvite("demo-prius-parts", "demo-prius-parts");
  await assert.rejects(f.store.bind(first.token, "151234", "151234", "demo"), TelegramStoreError);
  const binding = await f.store.bind(invite.token, "151234", "151234", "demo");
  assert.equal(binding.merchantId, "demo-prius-parts");
  assert.equal((await f.store.getMerchantBinding("demo-prius-parts"))?.userId, "151234");
  await assert.rejects(f.store.issueDashboardInvite("demo-prius-parts", "demo-prius-parts"), TelegramStoreError);

  const otherInvite = await f.store.issueDashboardInvite("demo-japan-used", "demo-japan-used");
  await f.store.bind(otherInvite.token, "151235", "151235", "demo");
  await f.store.revokeMerchantBinding("demo-prius-parts", "demo-prius-parts");
  assert.equal(await f.store.getMerchantBinding("demo-prius-parts"), null);
  assert.equal((await f.store.getMerchantBinding("demo-japan-used"))?.userId, "151235");
  assert.equal(f.rows("merchant_audit_events").filter(row => row.action === "telegram_revoked" && row.merchantId === "demo-prius-parts").length, 1);
});
test("arbitrary merchants, impersonated identities and duplicate active bindings are rejected", async () => {
  const f = fixtureMongo(); const { binding } = await registered(f);
  await assert.rejects(f.store.issueInvite("unknown-merchant", "101", "demo", "test-admin"), TelegramStoreError);
  assert.equal(await f.store.getBinding("101", "102", "demo"), null);
  assert.equal(await f.store.getBinding("101", "101", "production"), null);
  const foreign = await f.store.issueInvite("demo-japan-used", "101", "demo", "test-admin");
  await assert.rejects(f.store.bind(foreign.token, "101", "101", "demo"), TelegramStoreError);
  assert.equal(f.rows(telegramCollections.invites).find(row => row.id === foreign.id)!.consumed, false);
  await assert.rejects(f.store.getRFQContext({ ...binding, merchantId: "demo-japan-used" }, "anything"), TelegramStoreError);
});
test("revocation blocks saved binding objects and records one consequential audit", async () => {
  const f = fixtureMongo(); const { binding } = await registered(f); await received(f);
  await f.store.revokeBinding(binding.id, "test-admin"); await f.store.revokeBinding(binding.id, "test-admin");
  assert.equal(await f.store.getBinding("101", "101", "demo"), null);
  await assert.rejects(f.store.getRFQContext(binding, "rfq-1"), TelegramStoreError);
  await assert.rejects(f.store.saveDraft(binding, "rfq-1", draft(), "Гупер бэлэн, 650 мянга", 1), TelegramStoreError);
  assert.equal(f.rows("merchant_audit_events").filter(row => row.action === "telegram_revoked").length, 1);
});
test("update leases suppress duplicates, reject stale completion and retry a failed lease", async () => {
  const f = fixtureMongo(); const first = await f.store.claimUpdate("test-bot", 1); assert.ok(first);
  assert.equal(await f.store.claimUpdate("test-bot", 1), null);
  await assert.rejects(f.store.completeUpdate("test-bot", 1, "different-lease"), TelegramStoreError);
  assert.equal(f.rows(telegramCollections.updates)[0].status, "processing");
  assert.equal(await f.store.renewUpdate("test-bot", 1, "different-lease"), false);
  assert.equal(await f.store.renewUpdate("test-bot", 1, first), true);
  await f.store.failUpdate("test-bot", 1, first);
  const retry = await f.store.claimUpdate("test-bot", 1); assert.ok(retry); assert.notEqual(retry, first);
  await f.store.completeUpdate("test-bot", 1, retry); assert.equal(await f.store.claimUpdate("test-bot", 1), null);
  const other = await f.store.claimUpdate("other-bot", 1); assert.ok(other);
});
test("persistent drafts preserve RFQ scope, deterministic replay and newest reply ordering", async () => {
  const f = fixtureMongo(); const { binding } = await registered(f); await received(f);
  const saved = await f.store.saveDraft(binding, "rfq-1", draft(), "Гупер 650 мянга, шинэ", 10);
  assert.deepEqual(await f.store.saveDraft(binding, "rfq-1", draft(), "Гупер 650 мянга, шинэ", 10), saved);
  await assert.rejects(f.store.saveDraft(binding, "rfq-1", draft(), "Өөр текст", 10), TelegramStoreError);
  const latest = await f.store.saveDraft(binding, "rfq-1", draft(), "Гупер 650 мянга, бэлэн", 12);
  assert.deepEqual(await f.store.saveDraft(binding, "rfq-1", draft(), "Хуучин хариу", 11), latest);
  assert.equal(f.rows(telegramCollections.drafts).find(row => row.id === saved.id)!.status, "superseded");
  assert.equal(f.rows(telegramCollections.conversations).find(row => row.updateId === 11)!.status, "superseded");
  const { binding: foreign } = await registered(f, "demo-japan-used", "102");
  await assert.rejects(f.store.getDraft(foreign, latest.id), TelegramStoreError);
  await assert.rejects(f.store.rejectDraft(foreign, latest.id), TelegramStoreError);
  await assert.rejects(f.store.confirmDraft(foreign, latest.id, validateHumanQuote), TelegramStoreError);
  assert.equal(f.rows("merchant_quotes").length, 1);
});
test("conversation text survives failed extraction, expires and attaches to a draft without duplication", async () => {
  const f = fixtureMongo(); const { binding } = await registered(f); await received(f);
  const text = "Гупер 650 мянга, шинэ";
  await f.store.recordConversation(binding, "rfq-1", text, 10);
  await f.store.recordConversation(binding, "rfq-1", text, 10);
  assert.equal(f.rows(telegramCollections.conversations).length, 1);
  const saved = f.rows(telegramCollections.conversations)[0];
  assert.equal(saved.text, text); assert.ok(saved.expiresAt instanceof Date);
  assert.ok(saved.expiresAt.getTime() > Date.now() + 29 * 86400000); assert.equal(saved.draftId, undefined);
  await assert.rejects(f.store.recordConversation(binding, "rfq-1", "Өөр хариу", 10), TelegramStoreError);
  const record = await f.store.saveDraft(binding, "rfq-1", draft(), text, 10);
  assert.equal(f.rows(telegramCollections.conversations).length, 1);
  assert.equal(f.rows(telegramCollections.conversations)[0].draftId, record.id);
  assert.equal(f.rows(telegramCollections.conversations)[0].status, "draft");
});
test("confirmed publication is explicit, atomic, idempotent and visible only to its authenticated buyer", async () => {
  const f = fixtureMongo(); const { binding } = await registered(f); await received(f);
  const stockBefore = structuredClone(f.rows("merchant_inventory"));
  const saved = await f.store.saveDraft(binding, "rfq-1", draft(), "Гупер 650 мянга, бэлэн", 2);
  assert.equal(f.rows("merchant_quotes").length, 1); assert.equal(f.rows(telegramCollections.publications).length, 0);
  const confirmed = await f.store.confirmDraft(binding, saved.id, validateHumanQuote);
  assert.equal(confirmed.revision, 2); assert.equal(confirmed.reservation, false);
  assert.deepEqual(await f.store.confirmDraft(binding, saved.id, validateHumanQuote), confirmed);
  assert.equal(f.rows("merchant_quotes").length, 2); assert.equal(f.rows(telegramCollections.publications).length, 1);
  assert.deepEqual(f.rows("merchant_inventory"), stockBefore);
  const updates = await f.store.getQuoteUpdates("demo-prius-parts", "test-buyer", "rfq-1", 0);
  assert.deepEqual(updates.quotes.map(row => row.source), ["automatic", "human_confirmed"]);
  assert.equal(updates.quotes[0].quote.status, "superseded"); assert.equal(updates.latestRevision, 2);
  assert.equal((await f.store.getQuoteUpdates("demo-prius-parts", "test-buyer", "rfq-1", 2)).quotes.length, 0);
  await assert.rejects(f.store.getQuoteUpdates("demo-prius-parts", "someone-else", "rfq-1", 0), TelegramStoreError);
  assert.ok(!JSON.stringify(updates).includes("minimumPrice"));
});
test("rejection never publishes and expired RFQs cannot save or confirm drafts", async () => {
  const f = fixtureMongo(); const { binding } = await registered(f); await received(f);
  const rejected = await f.store.saveDraft(binding, "rfq-1", draft(), "Гупер 650 мянга, бэлэн", 2);
  await f.store.rejectDraft(binding, rejected.id); await f.store.rejectDraft(binding, rejected.id);
  await assert.rejects(f.store.confirmDraft(binding, rejected.id, validateHumanQuote), TelegramStoreError);
  const review = await f.store.saveDraft(binding, "rfq-1", draft(), "Гупер 650 мянга, бэлэн", 3);
  const stored = f.rows("merchant_rfq_processing")[0]; stored.envelope.expiresAt = new Date(Date.now() - 1).toISOString();
  await assert.rejects(f.store.confirmDraft(binding, review.id, validateHumanQuote), (error: unknown) => error instanceof TelegramStoreError && error.code === "rfq_expired");
  await assert.rejects(f.store.saveDraft(binding, "rfq-1", draft(), "Гупер бэлэн", 4), TelegramStoreError);
  assert.equal(f.rows("merchant_quotes").length, 1);
});
test("quote publication audit failure rolls back supersession, draft confirmation and all new records", async () => {
  const f = fixtureMongo(); const { binding } = await registered(f); await received(f);
  const saved = await f.store.saveDraft(binding, "rfq-1", draft(), "Гупер 650 мянга, бэлэн", 2);
  const auditCount = f.rows("merchant_audit_events").length; f.failAudit("quote_published");
  await assert.rejects(f.store.confirmDraft(binding, saved.id, validateHumanQuote), /Injected audit failure/);
  assert.equal(f.rows("merchant_quotes").length, 1); assert.equal(f.rows("merchant_quotes")[0].status, "offered");
  assert.equal(f.rows(telegramCollections.publications).length, 0); assert.equal(f.rows(telegramCollections.drafts)[0].status, "review");
  assert.equal(f.rows("merchant_audit_events").length, auditCount);
});
test("repair quote updates preserve the confirmed service window independently of later slot edits", async () => {
  const f = fixtureMongo(), merchantId = "demo-auto-care";
  const { binding } = await registered(f, merchantId);
  const slot = f.rows("merchant_slots").find(row => row.merchantId === merchantId)!;
  slot.startsAt = new Date(Date.now() + 86400000).toISOString(); slot.endsAt = new Date(Date.now() + 86400000 + 8 * 3600000).toISOString();
  await received(f, merchantId, "repair-rfq", "repair");
  const saved = await f.store.saveDraft(binding, "repair-rfq", { slotId: slot.id, lines: [{ itemIndex: 0,
    resourceId: `${merchantId}-service-0`, quantity: 1, unitPrice: { amountMinor: 15000000, currency: "MNT" },
    condition: null, available: true, warranty: null }] }, "Гупер солих 150 мянга, сонгосон цагт боломжтой", 1);
  await f.store.confirmDraft(binding, saved.id, validateHumanQuote);
  const confirmedWindow = { startsAt: slot.startsAt, endsAt: slot.endsAt };
  slot.startsAt = new Date(Date.now() + 2 * 86400000).toISOString();
  const updates = await f.store.getQuoteUpdates(merchantId, "test-buyer", "repair-rfq", 0);
  assert.deepEqual(updates.quotes[0].serviceWindow, confirmedWindow);
  assert.deepEqual(updates.quotes[1].serviceWindow, confirmedWindow);
});
