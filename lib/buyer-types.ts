import { z } from "zod";

export const buyerGoalSchema = z.object({
  vehicle: z.string(),
  parts: z.string(),
  tasks: z.string(),
  budget: z.number().finite(),
  days: z.number().int(),
  preference: z.string(),
});

export const buyerQuoteSchema = z.object({
  id: z.string(),
  partsMerchant: z.string(),
  repairMerchant: z.string(),
  kind: z.string(),
  parts: z.number().finite(),
  labor: z.number().finite(),
  total: z.number().finite(),
  days: z.number().int(),
  warranty: z.string(),
  revision: z.number().int(),
  expiresAt: z.number(),
  goal: buyerGoalSchema,

  // Сервер баталсан receipt дотор quote token хэрэггүй.
  token: z.string().optional(),
});

export const buyerReceiptSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  bookingId: z.string(),
  paymentId: z.string(),
  quote: buyerQuoteSchema,
  mode: z.literal("demo"),
  status: z.literal("demo_completed"),
});

export const buyerHistorySchema = z.object({
  history: z.array(buyerReceiptSchema),
});

export type BuyerReceipt = z.infer<typeof buyerReceiptSchema>;
