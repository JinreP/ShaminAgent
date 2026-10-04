import "server-only";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Db, Collection } from "mongodb";
import type { TelegramConfig } from "./config";
import { TelegramAPIError, type TelegramAPI } from "./api";
import type { TelegramUpdate } from "./contracts";

export type TelegramRuntime = {
  processUpdate(update: TelegramUpdate): Promise<void>;
  flushNotifications(): Promise<void>;
};
type TransportState = {
  _id: string; owner: string; mode: "polling" | "webhook" | "maintenance"; leaseUntil: Date; offset?: number;
  webhookRequests?: { id: string; until: Date }[];
};
const LEASE_MS = 90000;
const HEARTBEAT_MS = 15000;
function transportCollection(db: Db): Collection<TransportState> {
  return db.collection<TransportState>("merchant_telegram_transport");
}
export class TelegramTransportConflict extends Error {
  constructor() { super("Энэ ботын өөр ажиллагч ажиллаж байна. Эхлээд түүнийг зогсооно уу."); }
}

async function acquireLease(db: Db, config: TelegramConfig, owner: string, now: Date, administration: boolean): Promise<number> {
  try {
    const workerAvailable = { $or: [{ leaseUntil: { $lte: now } }, { owner }] };
    const state = await transportCollection(db).findOneAndUpdate({ _id: config.botKey,
      ...(config.mode === "polling" || administration ? { $and: [workerAvailable,
        { webhookRequests: { $not: { $elemMatch: { until: { $gt: now } } } } }] } : workerAvailable) }, {
      $set: { owner, mode: administration ? "maintenance" : config.mode, leaseUntil: new Date(now.getTime() + LEASE_MS) },
      $setOnInsert: { offset: 0 },
    }, { upsert: true, returnDocument: "after" });
    if (!state) throw new TelegramTransportConflict();
    return state.offset ?? 0;
  } catch (error) {
    if (error instanceof TelegramTransportConflict ||
        (typeof error === "object" && error !== null && "code" in error && error.code === 11000)) {
      throw new TelegramTransportConflict();
    }
    throw error;
  }
}
export async function acquireTelegramLease(db: Db, config: TelegramConfig, owner: string, now = new Date()): Promise<number> {
  return acquireLease(db, config, owner, now, false);
}
export async function acquireTelegramAdministrationLease(db: Db, config: TelegramConfig, owner: string, now = new Date()): Promise<number> {
  return acquireLease(db, config, owner, now, true);
}
export async function releaseTelegramLease(db: Db, config: TelegramConfig, owner: string): Promise<void> {
  await transportCollection(db).updateOne({ _id: config.botKey, owner }, { $set: { leaseUntil: new Date(0) } });
}
/** A request lease closes the webhook-check/polling-start race without taking the outbox worker's ownership. */
export async function withTelegramWebhookLease(db: Db, config: TelegramConfig, process: () => Promise<void>): Promise<void> {
  if (config.mode !== "webhook") throw new TelegramTransportConflict();
  const requestId = randomUUID(), now = new Date();
  try {
    await transportCollection(db).updateOne({ _id: config.botKey }, { $pull: { webhookRequests: { until: { $lte: now } } } });
    const state = await transportCollection(db).findOneAndUpdate({ _id: config.botKey,
      $or: [{ mode: "webhook" }, { leaseUntil: { $lte: now } }] }, {
      $set: { mode: "webhook" },
      $setOnInsert: { owner: "webhook-request", leaseUntil: new Date(0), offset: 0 },
      $push: { webhookRequests: { id: requestId, until: new Date(now.getTime() + LEASE_MS) } },
    }, { upsert: true, returnDocument: "after" });
    if (!state) throw new TelegramTransportConflict();
  } catch (error) {
    if (error instanceof TelegramTransportConflict ||
        (typeof error === "object" && error !== null && "code" in error && error.code === 11000)) throw new TelegramTransportConflict();
    throw error;
  }
  let renewing = false, lostLease = false;
  const heartbeat = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      const result = await transportCollection(db).updateOne({ _id: config.botKey, mode: "webhook", "webhookRequests.id": requestId },
        { $set: { "webhookRequests.$.until": new Date(Date.now() + LEASE_MS) } });
      if (result.matchedCount !== 1) lostLease = true;
    } catch { lostLease = true; }
    finally { renewing = false; }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    await process();
    if (lostLease) throw new TelegramTransportConflict();
  } finally {
    clearInterval(heartbeat);
    await transportCollection(db).updateOne({ _id: config.botKey }, { $pull: { webhookRequests: { id: requestId } } });
  }
}

type WorkerOptions = {
  db: Db; config: TelegramConfig; telegram: TelegramAPI; runtime: TelegramRuntime; signal: AbortSignal;
  logger?: (message: string) => void; idleMs?: number;
};
/** A dedicated process only. Importing this module never starts a worker. */
export async function runTelegramWorker(options: WorkerOptions): Promise<void> {
  const { db, config, telegram, runtime, signal } = options;
  const logger = options.logger ?? console.log;
  const owner = randomUUID();
  let offset = await acquireTelegramLease(db, config, owner);
  const controller = new AbortController();
  const stopped = AbortSignal.any([signal, controller.signal]);
  let heartbeatRunning = false;
  let leaseFailure = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatRunning || stopped.aborted) return;
    heartbeatRunning = true;
    try {
      const now = new Date();
      const result = await transportCollection(db).updateOne({ _id: config.botKey, owner, leaseUntil: { $gt: now } },
        { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS) } });
      if (result.matchedCount !== 1) throw new TelegramTransportConflict();
    } catch {
      leaseFailure = true;
      controller.abort();
      logger("Ажиллагчийн эзэмших эрх тасарлаа. Ажиллагчийг зогсоож байна.");
    } finally { heartbeatRunning = false; }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    stopped.throwIfAborted();
    await telegram.getMe();
    if (config.mode === "polling") await telegram.deleteWebhook();
    logger(config.mode === "polling" ? "Телеграмын хүсэлт хүлээн авагч ажиллаж байна." : "Телеграмын мэдэгдэл илгээгч ажиллаж байна.");
    while (!stopped.aborted) {
      try {
        await runtime.flushNotifications();
        if (config.mode === "webhook") {
          await delay(options.idleMs ?? 2000, undefined, { signal: stopped });
          continue;
        }
        const updates = await telegram.getUpdates(offset, stopped);
        for (const update of updates.sort((left, right) => left.update_id - right.update_id)) {
          stopped.throwIfAborted();
          if (update.update_id < offset) continue;
          await runtime.processUpdate(update);
          stopped.throwIfAborted();
          const nextOffset = update.update_id + 1;
          const result = await transportCollection(db).updateOne({ _id: config.botKey, owner, leaseUntil: { $gt: new Date() } },
            { $set: { offset: nextOffset } });
          if (result.matchedCount !== 1) throw new TelegramTransportConflict();
          offset = nextOffset;
        }
        // Mock servers and a Telegram empty immediate response must not cause a busy loop.
        if (!updates.length) await delay(options.idleMs ?? 250, undefined, { signal: stopped });
      } catch (error) {
        if (stopped.aborted) break;
        if (error instanceof TelegramTransportConflict) throw error;
        if (error instanceof TelegramAPIError && ["unauthorized", "conflict"].includes(error.code)) throw error;
        logger(error instanceof TelegramAPIError ? error.message : "Телеграмын хүсэлтийг боловсруулж чадсангүй. Дахин оролдоно.");
        await delay(error instanceof TelegramAPIError && error.retryAfter ? error.retryAfter * 1000 : 2000,
          undefined, { signal: stopped });
      }
    }
    if (leaseFailure) throw new TelegramTransportConflict();
  } catch (error) {
    if (!stopped.aborted || leaseFailure) throw error;
  } finally {
    clearInterval(heartbeat);
    await releaseTelegramLease(db, config, owner);
    logger("Телеграмын ажиллагч зогслоо.");
  }
}
