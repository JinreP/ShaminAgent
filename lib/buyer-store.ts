import "server-only";

import { randomUUID } from "node:crypto";
import { MongoServerError } from "mongodb";

import { getDb } from "@/lib/mongodb";
import { getBuyerSession } from "@/lib/buyer-session";
import { buyerReceiptSchema, type BuyerReceipt } from "@/lib/buyer-types";
import type { RepairReport } from "@/lib/repair-report";

type ReportDocument = {
  _id: string;
  ownerId: string;
  report: string;
  extracted: RepairReport;
  createdAt: Date;
};

type ReceiptDocument = {
  _id: string;
  ownerId: string;
  receipt: BuyerReceipt;
  createdAt: Date;
};

export async function saveBuyerReport(report: string, extracted: RepairReport) {
  const ownerId = await getBuyerSession();
  const db = await getDb();
  const reportId = randomUUID();

  await db.collection<ReportDocument>("buyerReports").insertOne({
    _id: reportId,
    ownerId,
    report,
    extracted,
    createdAt: new Date(),
  });

  return reportId;
}

export async function saveBuyerReceipt(value: unknown) {
  // Зөвхөн серверийн баталсан receipt-ийг энэ function-д өгнө.
  const receipt = buyerReceiptSchema.parse(value);
  const ownerId = await getBuyerSession();
  const db = await getDb();

  const collection = db.collection<ReceiptDocument>("buyerReceipts");

  const documentId = `${ownerId}:${receipt.id}`;

  try {
    await collection.updateOne(
      { _id: documentId },
      {
        $setOnInsert: {
          ownerId,
          receipt,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    // Зэрэг ирсэн хоёр Confirm-ийн нэг нь эхэлж хадгалсан байж болно.
    if (!(error instanceof MongoServerError) || error.code !== 11000) {
      throw error;
    }
  }

  const saved = await collection.findOne({
    _id: documentId,
    ownerId,
  });

  if (!saved) {
    throw new Error("Баримт хадгалагдсангүй.");
  }

  return buyerReceiptSchema.parse(saved.receipt);
}

export async function getBuyerHistory() {
  const ownerId = await getBuyerSession();
  const db = await getDb();

  const documents = await db
    .collection<ReceiptDocument>("buyerReceipts")
    .find({ ownerId })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();

  return documents.map((document) =>
    buyerReceiptSchema.parse(document.receipt),
  );
}
