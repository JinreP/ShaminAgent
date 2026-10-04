import "server-only";

import { MongoClient } from "mongodb";

const mongoGlobal = globalThis as typeof globalThis & {
  buyerMongoPromise?: Promise<MongoClient>;
};

export async function getDb() {
  const uri = process.env.MONGODB_URI;
  const databaseName = process.env.MONGODB_DB;

  if (!uri || !databaseName) {
    throw new Error("MONGODB_URI болон MONGODB_DB тохируулаагүй байна.");
  }

  if (!mongoGlobal.buyerMongoPromise) {
    const client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
    });

    mongoGlobal.buyerMongoPromise = client
      .connect()
      .catch(async (error: unknown) => {
        mongoGlobal.buyerMongoPromise = undefined;
        await client.close().catch(() => undefined);
        throw error;
      });
  }

  const client = await mongoGlobal.buyerMongoPromise;

  return client.db(databaseName);
}
