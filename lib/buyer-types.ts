import { z } from "zod";
import { repairReportSchema } from "@/lib/repair-report";
import { quoteSchema as merchantQuoteSchema } from "@/shared/merchant-contracts";
import { bookingTermsSchema } from "@/merchant/commerce/contracts";

export const merchantOfferSchema = z.object({
  quote: merchantQuoteSchema,
  correlationId: z.string(),
});
export const merchantBundleSchema = z.object({
  parts: merchantOfferSchema,
  repair: merchantOfferSchema,
  booking: bookingTermsSchema,
});
export const buyerCheckoutSchema = z.object({
  transactionId: z.string(),
  quoteToken: z.string().uuid(),
  approvedTotal: z.number(),
  approvalId: z.string().optional(),
  approvalUrl: z.string().url().optional(),
  expiresAt: z.string(),
});
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
  merchant: merchantBundleSchema.optional(),
});

export const buyerReceiptSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  bookingId: z.string(),
  paymentId: z.string(),
  quote: buyerQuoteSchema,
  mode: z.literal("demo"),
  status: z.literal("demo_completed"),
  transactionId: z.string().optional(),
  source: z.literal("merchant").optional(),
});

export const buyerHistorySchema = z.object({
  history: z.array(buyerReceiptSchema),
});

export type BuyerReceipt = z.infer<typeof buyerReceiptSchema>;
export const savedRequestSummarySchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["draft", "quoted", "completed"]),
  vehicle: z.string(),
  budget: z.number(),
  updatedAt: z.string(),
});

export const savedRequestSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["draft", "quoted", "completed"]),
  report: z.string(),
  extracted: repairReportSchema.optional(),
  goal: buyerGoalSchema.optional(),
  quotes: z.array(
    buyerQuoteSchema.extend({
      token: z.string().uuid(),
    }),
  ),
  selectedQuote: buyerQuoteSchema
    .extend({
      token: z.string().uuid(),
    })
    .optional(),
  receipt: buyerReceiptSchema.optional(),
  checkout: buyerCheckoutSchema.optional(),
  pendingTarget: z.number().optional(),
  updatedAt: z.string(),
});

export const savedRequestsResponseSchema = z.object({
  requests: z.array(savedRequestSummarySchema),
});

export const savedRequestResponseSchema = z.object({
  request: savedRequestSchema,
});

export type SavedRequestSummary = z.infer<typeof savedRequestSummarySchema>;
