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

export class BuyerWorkflowError extends Error {}

export const validGoalSchema = buyerGoalSchema.extend({
  vehicle: z.string().trim().min(1).max(200),
  parts: z.string().trim().min(1).max(2000),
  tasks: z.string().trim().min(1).max(2000),
  budget: z.number().finite().positive(),
  days: z.number().int().min(1).max(30),
  preference: z.enum(["Any", "OEM", "Aftermarket", "Used"]),
});

const storedQuoteSchema = buyerQuoteSchema.extend({
  token: z.string().uuid(),
});

type Goal = z.infer<typeof validGoalSchema>;
type Quote = z.infer<typeof storedQuoteSchema>;

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

const demoMerchants = [
  {
    id: "a",
    partsMerchant: "Prius Parts",
    repairMerchant: "Auto Care",
    kind: "Aftermarket",
    parts: 1050000,
    labor: 500000,
    days: 3,
    warranty: "3 сар",
  },
  {
    id: "b",
    partsMerchant: "Japan Used",
    repairMerchant: "Quick Garage",
    kind: "Used",
    parts: 900000,
    labor: 400000,
    days: 2,
    warranty: "1 сар",
  },
  {
    id: "c",
    partsMerchant: "OEM Center",
    repairMerchant: "Auto Care",
    kind: "OEM",
    parts: 1750000,
    labor: 500000,
    days: 3,
    warranty: "6 сар",
  },
];

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

export async function getRequestQuotes(requestId: string, goal: Goal) {
  const { ownerId, requests } = await context();

  const current = await requests.findOne({
    _id: requestId,
    ownerId,
  });

  if (!current) {
    throw new BuyerWorkflowError("Хүсэлт олдсонгүй.");
  }

  if (current.status === "completed") {
    throw new BuyerWorkflowError(
      "Дууссан хүсэлтийг өөрчлөхгүй. Шинэ хүсэлт үүсгээрэй.",
    );
  }

  if (
    goal.vehicle !== "Toyota Prius 30" ||
    goal.parts !== "Урд бампер, зүүн урд гэрэл" ||
    goal.tasks !== "Солих, бампер будах"
  ) {
    throw new BuyerWorkflowError(
      "Demo merchant зөвхөн Prius 30-ийн урд бампер, зүүн гэрэл солих болон бампер будах хүсэлтийг дэмжинэ.",
    );
  }

  const now = new Date();

  const quotes: Quote[] = demoMerchants
    .filter(
      (merchant) =>
        goal.preference === "Any" || merchant.kind === goal.preference,
    )
    .map((merchant) => ({
      ...merchant,
      total: merchant.parts + merchant.labor,
      goal,
      revision: 1,
      expiresAt: Date.now() + 15 * 60 * 1000,

      // Үнэ браузераас авахгүй.
      // Token-оор MongoDB дахь саналыг олно.
      token: randomUUID(),
    }));

  const updated = await requests.updateOne(
    {
      _id: requestId,
      ownerId,
      version: current.version,
      status: { $in: ["draft", "quoted"] },
    },
    {
      $set: {
        goal,
        quotes,
        status: "quoted",
        updatedAt: now,
      },
      $unset: {
        selectedQuote: "",
        approval: "",
      },
      $inc: { version: 1 },
      $push: {
        events: {
          action: "goal_confirmed_and_quotes_received",
          at: now,
        },
      },
    },
  );

  if (updated.matchedCount !== 1) {
    throw new BuyerWorkflowError("Хүсэлт өөрчлөгдсөн байна. Дахин оролдоорой.");
  }

  return { requestId, quotes, mode: "demo" };
}

function assertActiveQuote(quote: Quote) {
  if (quote.expiresAt <= Date.now()) {
    throw new BuyerWorkflowError(
      "Саналын хугацаа дууссан. Дахин санал аваарай.",
    );
  }
}

export async function negotiateRequest(
  requestId: string,
  token: string,
  target: number,
) {
  const { ownerId, requests } = await context();

  const current = await requests.findOne({
    _id: requestId,
    ownerId,
    status: "quoted",
  });

  const quote = current?.quotes.find((item) => item.token === token);

  if (!current || !quote) {
    throw new BuyerWorkflowError("Санал олдсонгүй эсвэл шинэчлэгдсэн байна.");
  }

  assertActiveQuote(quote);

  if (quote.revision !== 1) {
    throw new BuyerWorkflowError("Demo дээр нэг удаа үнэ тохиролцоно.");
  }

  if (target <= 0 || target >= quote.total) {
    throw new BuyerWorkflowError("Зорилтот үнэ одоогийн үнээс бага байна.");
  }

  const minimumParts = Math.ceil(quote.parts * 0.96);
  const minimumLabor = Math.ceil(quote.labor * 0.94);
  const total = Math.max(target, minimumParts + minimumLabor);
  const discount = quote.total - total;

  const parts = quote.parts - Math.min(quote.parts - minimumParts, discount);

  const nextQuote: Quote = {
    ...quote,
    parts,
    labor: total - parts,
    total,
    revision: 2,
    token: randomUUID(),
  };

  const nextQuotes = current.quotes.map((item) =>
    item.token === token ? nextQuote : item,
  );

  const now = new Date();

  const updated = await requests.updateOne(
    {
      _id: requestId,
      ownerId,
      status: "quoted",
      version: current.version,
    },
    {
      $set: {
        quotes: nextQuotes,
        selectedQuote: nextQuote,
        updatedAt: now,
      },
      $unset: { approval: "" },
      $inc: { version: 1 },
      $push: {
        events: {
          action: "quote_negotiated",
          at: now,
        },
      },
    },
  );

  if (updated.matchedCount !== 1) {
    throw new BuyerWorkflowError(
      "Санал өөрчлөгдсөн байна. Шинэ саналаа шалгаарай.",
    );
  }

  return {
    requestId,
    quote: nextQuote,
    message:
      total <= target
        ? "Demo merchant-ууд таны үнийг зөвшөөрлөө."
        : "Demo merchant-ууд эсрэг санал өглөө.",
  };
}

export async function confirmRequest(
  requestId: string,
  token: string,
  approvedTotal: number,
) {
  const { ownerId, requests } = await context();

  const current = await requests.findOne({
    _id: requestId,
    ownerId,
  });

  if (!current) {
    throw new BuyerWorkflowError("Хүсэлт олдсонгүй.");
  }

  // Амжилттай Confirm-ийг дахин явуулбал ижил баримт буцаана.
  if (current.status === "completed") {
    if (
      current.receipt &&
      current.receiptToken === token &&
      current.receipt.quote.total === approvedTotal
    ) {
      return {
        requestId,
        receipt: buyerReceiptSchema.parse(current.receipt),
      };
    }

    throw new BuyerWorkflowError(
      "Энэ хүсэлт өөр саналаар аль хэдийн батлагдсан.",
    );
  }

  const quote = current.quotes.find((item) => item.token === token);

  if (current.status !== "quoted" || !quote) {
    throw new BuyerWorkflowError("Батлах санал олдсонгүй.");
  }

  assertActiveQuote(quote);

  if (approvedTotal !== quote.total) {
    throw new BuyerWorkflowError(
      "Үнэ өөрчлөгдсөн байна. Эцсийн үнийг дахин зөвшөөрөөрэй.",
    );
  }

  const now = new Date();
  const id = requestId.toUpperCase();

  const receipt = buyerReceiptSchema.parse({
    id,
    orderId: `ORD-${id}`,
    bookingId: `BOOK-${id}`,
    paymentId: `MOCK-${id}`,
    quote,
    mode: "demo",
    status: "demo_completed",
  });

  // Зөвшөөрөл болон demo баримтыг нэг document-д
  // нэг atomic update-аар хадгална.
  const updated = await requests.updateOne(
    {
      _id: requestId,
      ownerId,
      status: "quoted",
      version: current.version,
    },
    {
      $set: {
        selectedQuote: quote,
        approval: {
          approved: true,
          total: quote.total,
          quoteToken: token,
          at: now,
        },
        receipt,
        receiptToken: token,
        status: "completed",
        updatedAt: now,
      },
      $inc: { version: 1 },
      $push: {
        events: {
          $each: [
            { action: "user_approved", at: now },
            { action: "demo_completed", at: now },
          ],
        },
      },
    },
  );

  if (updated.matchedCount !== 1) {
    // Зэрэг ирсэн хоёр Confirm-ийн эхнийх хадгалсан байж болно.
    const saved = await requests.findOne({
      _id: requestId,
      ownerId,
      status: "completed",
      receiptToken: token,
    });

    if (saved?.receipt && saved.receipt.quote.total === approvedTotal) {
      return {
        requestId,
        receipt: buyerReceiptSchema.parse(saved.receipt),
      };
    }

    throw new BuyerWorkflowError("Хүсэлт өөрчлөгдсөн байна. Дахин шалгаарай.");
  }

  return { requestId, receipt };
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
