import 'server-only';
import { MongoClient, type Db, type IndexDescription } from "mongodb";
import { readDatabaseEnv } from "./env";

let connection: Promise<MongoClient> | undefined;
export async function getMerchantClient(): Promise<MongoClient> {
  if (!connection) {
    const env = readDatabaseEnv();
    const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    connection = client.connect().catch(async () => {
      connection = undefined;
      await client.close();
      throw new Error("Merchant database connection failed");
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
  merchant_quotes: [identity, { key: { merchantId: 1, rfqId: 1, revision: 1 }, unique: true }],
  merchant_negotiations: [identity, { key: { merchantId: 1, quoteId: 1, createdAt: -1 } }],
  merchant_approvals: [identity, { key: { merchantId: 1, buyerId: 1, quoteId: 1, quoteRevision: 1 } }],
  merchant_transactions: [identity,
    { key: { merchantId: 1, idempotencyKey: 1 }, unique: true },
    { key: { merchantId: 1, approvalId: 1 }, unique: true },
    { key: { merchantId: 1, buyerId: 1, quoteId: 1, quoteRevision: 1, kind: 1 }, unique: true }],
  merchant_audit_events: [identity, { key: { merchantId: 1, entityId: 1, createdAt: -1 } }],
  merchant_inventory: [identity],
  merchant_services: [identity],
  merchant_slots: [identity, { key: { merchantId: 1, startsAt: 1 } }],
  merchant_settings: [identity],
};
// Explicit initialization: import/build never connects or mutates a database.
export async function initializeMerchantDatabase(db: Db): Promise<void> {
  for (const [name, indexes] of Object.entries(merchantIndexes)) {
    await db.collection(name).createIndexes(indexes);
  }
}
