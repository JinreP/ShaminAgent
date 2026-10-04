import 'server-only';
import { MongoClient, type Db, type IndexDescription } from "mongodb";
import { readDatabaseEnv } from "./env";
import { explainMerchantFailure } from "./diagnostics";

let connection: Promise<MongoClient> | undefined;
export async function getMerchantClient(): Promise<MongoClient> {
  if (!connection) {
    const env = readDatabaseEnv();
    const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    connection = client.connect().catch(async (cause: unknown) => {
      connection = undefined;
      await client.close().catch(() => {});
      throw new Error(explainMerchantFailure(cause).message, { cause });
    });
  }
  return connection;
}
export async function getMerchantDb(): Promise<Db> {
  return (await getMerchantClient()).db(readDatabaseEnv().MONGODB_DB);
}
export async function closeMerchantConnection(): Promise<void> {
  const pending = connection;
  connection = undefined;
  if (pending) await (await pending).close();
}
const identity: IndexDescription = { key: { merchantId: 1, id: 1 }, unique: true, name: "merchant_identity" };
export const merchantIndexes: Record<string, IndexDescription[]> = {
  merchant_profiles: [identity],
  merchant_rfqs: [identity, { key: { merchantId: 1, buyerId: 1, createdAt: -1 } }],
  merchant_rfq_processing: [identity, { key: { merchantId: 1, correlationId: 1 } }],
  merchant_quotes: [identity, { key: { merchantId: 1, rfqId: 1, revision: 1 }, unique: true }],
  merchant_negotiations: [identity, { key: { merchantId: 1, quoteId: 1, createdAt: -1 } }],
  merchant_negotiation_processing: [identity,
    { key: { merchantId: 1, rfqId: 1, status: 1 } },
    { key: { merchantId: 1, telegramHandle: 1 }, unique: true },
    { key: { status: 1, notificationStatus: 1, nextAttemptAt: 1 } }],
  merchant_negotiation_guards: [identity],
  merchant_approvals: [identity, { key: { merchantId: 1, buyerId: 1, quoteId: 1, quoteRevision: 1 } }],
  merchant_transactions: [identity,
    { key: { merchantId: 1, idempotencyKey: 1 }, unique: true },
    { key: { merchantId: 1, approvalId: 1 }, unique: true },
    { key: { merchantId: 1, buyerId: 1, quoteId: 1, quoteRevision: 1, kind: 1 }, unique: true }],
  merchant_commerce_approvals: [identity, { key: { merchantId: 1, transactionId: 1 }, unique: true },
    { key: { transactionId: 1 }, unique: true },
    { key: { challengeHash: 1 }, unique: true }, { key: { buyerId: 1, status: 1, expiresAt: 1 } }],
  merchant_commerce_transactions: [identity, { key: { id: 1 }, unique: true }, { key: { buyerId: 1, id: 1 }, unique: true },
    { key: { "quoteSelections.merchantId": 1, createdAt: -1 } }, { key: { status: 1, updatedAt: -1 } }],
  merchant_parts_orders: [identity, { key: { merchantId: 1, transactionId: 1 }, unique: true }, { key: { merchantId: 1, status: 1, createdAt: -1 } }],
  merchant_repair_bookings: [identity, { key: { transactionId: 1 }, unique: true }, { key: { merchantId: 1, status: 1, startsAt: 1 } }],
  merchant_inventory_reservations: [identity, { key: { transactionId: 1, merchantId: 1, resourceId: 1 }, unique: true }],
  merchant_slot_reservations: [identity, { key: { transactionId: 1, merchantId: 1 }, unique: true },
    { key: { merchantId: 1, slotId: 1, status: 1 } }],
  merchant_slot_reservation_counters: [identity],
  merchant_mock_payments: [identity, { key: { transactionId: 1 }, unique: true }, { key: { buyerId: 1, createdAt: -1 } }],
  merchant_compensation_attempts: [identity, { key: { transactionId: 1, createdAt: -1 } }],
  merchant_audit_events: [identity, { key: { merchantId: 1, entityId: 1, createdAt: -1 } }],
  merchant_inventory: [identity],
  merchant_services: [identity],
  merchant_slots: [identity, { key: { merchantId: 1, startsAt: 1 } }],
  merchant_settings: [identity],
  merchant_telegram_invites: [identity, { key: { tokenHash: 1 }, unique: true },
    { key: { merchantId: 1, mode: 1 }, unique: true, partialFilterExpression: { dashboardInvite: true, consumed: false } },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  merchant_telegram_bindings: [identity,
    { key: { mode: 1, chatId: 1 }, unique: true, partialFilterExpression: { active: true } },
    { key: { mode: 1, merchantId: 1 }, unique: true, partialFilterExpression: { active: true } }],
  merchant_telegram_updates: [{ key: { botKey: 1, updateId: 1 }, unique: true }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  merchant_telegram_negotiation_events: [identity, { key: { merchantId: 1, negotiationId: 1, updateId: 1 } }],
  merchant_telegram_notifications: [identity, { key: { status: 1, nextAttemptAt: 1 } }],
  merchant_telegram_drafts: [identity, { key: { merchantId: 1, rfqId: 1, bindingId: 1, telegramUpdateId: -1 } }],
  merchant_telegram_conversations: [identity, { key: { merchantId: 1, chatId: 1, createdAt: -1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  merchant_telegram_sessions: [{ key: { merchantId: 1, bindingId: 1 }, unique: true }],
  merchant_telegram_message_links: [{ key: { merchantId: 1, bindingId: 1, messageId: 1 }, unique: true }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  merchant_quote_publications: [identity, { key: { merchantId: 1, rfqId: 1, quoteRevision: 1 }, unique: true }],
};
// Explicit initialization: import/build never connects or mutates a database.
export async function initializeMerchantDatabase(db: Db): Promise<void> {
  for (const [name, indexes] of Object.entries(merchantIndexes)) {
    await db.collection(name).createIndexes(indexes);
  }
}
