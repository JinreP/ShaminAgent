import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getDb } from "@/lib/mongodb";
import { getBuyerSession } from "@/lib/buyer-session";
import {
  buyerGoalSchema,
  buyerQuoteSchema,
  buyerReceiptSchema,
  type BuyerReceipt,
} from "@/lib/buyer-types";
import type { RepairReport } from "@/lib/repair-report";

import { createBuyerMerchantGateway } from "./buyer-merchant-client";
import { BuyerMerchantWorkflow, BuyerWorkflowError } from "./buyer-merchant-workflow";
import { buyerCheckoutSchema } from "./buyer-types";
export { BuyerWorkflowError };

export const validGoalSchema = buyerGoalSchema.extend({
  vehicle: z.string().trim().min(1).max(200),
  parts: z.string().trim().min(1).max(2000),
  tasks: z.string().trim().min(1).max(2000),
  budget: z.number().int().positive().max(Math.floor(Number.MAX_SAFE_INTEGER / 100)),
  days: z.number().int().min(1).max(30),
  preference: z.enum(["Any", "OEM", "Aftermarket", "Used"]),
});

type Goal = z.infer<typeof validGoalSchema>;
type Quote = z.infer<typeof buyerQuoteSchema> & { token: string };

type Event = {
  action: string;
  at: Date;
};

type RepairRequestDocument = {
  _id: string;
  ownerId: string;
  status: "draft" | "quoted" | "completed";
  version: number;
  source: "ai" | "manual";
  report: string;
  extracted?: RepairReport;
  goal?: Goal;
  quotes: Quote[];
  selectedQuote?: Quote;
  approval?: {
    approved: true;
    total: number;
    quoteToken: string;
    at: Date;
  };
  receipt?: BuyerReceipt;
  receiptToken?: string;
  checkout?: z.infer<typeof buyerCheckoutSchema>;
  pendingNegotiation?: { target: number };
  events: Event[];
  createdAt: Date;
  updatedAt: Date;
};

type LegacyReceiptDocument = {
  _id: string;
  ownerId: string;
  receipt: BuyerReceipt;
  createdAt: Date;
};

async function context() {
  const ownerId = await getBuyerSession();
  const db = await getDb();

  return {
    ownerId,
    db,
    requests: db.collection<RepairRequestDocument>("repairRequests"),
  };
}

async function createDraft(report: string, extracted?: RepairReport) {
  const { ownerId, requests } = await context();
  const requestId = randomUUID();
  const now = new Date();

  await requests.insertOne({
    _id: requestId,
    ownerId,
    status: "draft",
    version: 1,
    source: extracted ? "ai" : "manual",
    report,
    ...(extracted ? { extracted } : {}),
    quotes: [],
    events: [
      {
        action: extracted ? "report_extracted" : "draft_created",
        at: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  });

  return requestId;
}

// Өмнөх parse-report endpoint энэ function-ийг ашиглана.
// Буцааж байгаа reportId нь одоо requestId мөн.
export function saveBuyerReport(report: string, extracted: RepairReport) {
  return createDraft(report, extracted);
}

export function createManualRequest(report: string) {
  return createDraft(report);
}

async function merchantWorkflow() {
  const { db, ownerId } = await context();
  return new BuyerMerchantWorkflow(db, ownerId, createBuyerMerchantGateway());
}
export async function getRequestQuotes(requestId: string, goal: Goal) {
  return (await merchantWorkflow()).quotes(requestId, goal);
}
export async function negotiateRequest(requestId: string, token: string, target: number) {
  return (await merchantWorkflow()).negotiate(requestId, token, target);
}
export async function confirmRequest(requestId: string, token: string, approvedTotal: number) {
  return (await merchantWorkflow()).confirm(requestId, token, approvedTotal);
}

export async function getBuyerHistory() {
  const { ownerId, requests, db } = await context();

  const [completed, legacy] = await Promise.all([
    requests
      .find({
        ownerId,
        status: "completed",
      })
      .sort({ updatedAt: -1 })
      .limit(20)
      .toArray(),

    db
      .collection<LegacyReceiptDocument>("buyerReceipts")
      .find({ ownerId })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray(),
  ]);

  const items = [
    ...completed.flatMap((item) =>
      item.receipt
        ? [
            {
              receipt: item.receipt,
              date: item.updatedAt.getTime(),
            },
          ]
        : [],
    ),
    ...legacy.map((item) => ({
      receipt: item.receipt,
      date: item.createdAt.getTime(),
    })),
  ].sort((a, b) => b.date - a.date);

  const seen = new Set<string>();
  const history: BuyerReceipt[] = [];

  for (const item of items) {
    const receipt = buyerReceiptSchema.parse(item.receipt);

    if (seen.has(receipt.id)) continue;

    seen.add(receipt.id);
    history.push(receipt);

    if (history.length === 20) break;
  }

  return history;
}
export async function listBuyerRequests() {
  const { ownerId, requests } = await context();

  const documents = await requests
    .find(
      { ownerId },
      {
        projection: {
          _id: 1,
          status: 1,
          "goal.vehicle": 1,
          "goal.budget": 1,
          "extracted.vehicle": 1,
          updatedAt: 1,
        },
      },
    )
    .sort({ updatedAt: -1 })
    .limit(50)
    .toArray();

  return documents.map((document) => ({
    id: document._id,
    status: document.status,
    vehicle:
      document.goal?.vehicle ||
      document.extracted?.vehicle ||
      "Машин тодорхойгүй",
    budget: document.goal?.budget ?? 0,
    updatedAt: document.updatedAt.toISOString(),
  }));
}

export async function readBuyerRequest(requestId: string) {
  const { ownerId, requests } = await context();

  const document = await requests.findOne({
    _id: requestId,
    ownerId,
  });

  if (!document) {
    throw new BuyerWorkflowError("Хүсэлт олдсонгүй.");
  }

  return {
    id: document._id,
    status: document.status,
    report: document.report,
    extracted: document.extracted,
    goal: document.goal,
    quotes: document.quotes,
    selectedQuote: document.selectedQuote,
    receipt: document.receipt,
    checkout: document.checkout,
    pendingTarget: document.pendingNegotiation?.target,
    updatedAt: document.updatedAt.toISOString(),
  };
}
