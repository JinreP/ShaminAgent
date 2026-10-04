import { z } from "zod";
import { idSchema, timestampSchema, rfqSchema, quoteSchema } from "../../shared/merchant-contracts";
import type { QuoteUpdatesResponse } from "../telegram/contracts";
import type { NegotiationResponse } from "../negotiation/contracts";

// Additive A2A domain payload; existing v1 RFQ/Quote fields are unchanged.
export const merchantRFQEnvelopeSchema = z.strictObject({
  contractVersion: z.literal("1"), rfq: rfqSchema, expiresAt: timestampSchema, correlationId: idSchema,
}).refine(v => v.rfq.status === "received", "Шинэ хүсэлтийн төлөв received байх ёстой.")
  .refine(v => Date.parse(v.expiresAt) > Date.parse(v.rfq.createdAt), "Хүсэлтийн хүчинтэй хугацаа үүссэн хугацаанаас хойш байна.");
export const rfqIssueSchema = z.strictObject({
  code: z.enum(["partial_availability", "insufficient_stock", "item_unavailable", "unsupported_vehicle", "unsupported_capability", "no_repair_slot", "merchant_rejected", "rfq_expired", "processing_error"]),
  message: z.string().min(1), itemIndex: z.number().int().nonnegative().optional(),
});
export const merchantRFQResponseSchema = z.strictObject({
  contractVersion: z.literal("1"), merchantId: idSchema, rfqId: idSchema, correlationId: idSchema,
  outcome: z.enum(["quoted", "partial", "declined", "expired", "failed"]),
  message: z.string().min(1), issues: z.array(rfqIssueSchema), quote: quoteSchema.optional(),
  serviceWindow: z.strictObject({ startsAt: timestampSchema, endsAt: timestampSchema }).optional(),
}).refine(v => (v.outcome === "quoted" || v.outcome === "partial") === Boolean(v.quote), "Үнийн саналын үр дүн тохирохгүй байна.");
export type MerchantRFQEnvelope = z.infer<typeof merchantRFQEnvelopeSchema>;
export type MerchantRFQResponse = z.infer<typeof merchantRFQResponseSchema>;
export type MerchantA2AResponse = MerchantRFQResponse | QuoteUpdatesResponse | NegotiationResponse;
