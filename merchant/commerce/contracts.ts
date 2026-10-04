import { z } from "zod";
import { idSchema, moneySchema, quoteSchema, timestampSchema, transactionSchema } from "../../shared/merchant-contracts";

export const quoteSelectionSchema = z.strictObject({
  merchantId: idSchema,
  quoteId: idSchema,
  quoteRevision: z.number().int().positive(),
});
export const bookingTermsSchema = z.strictObject({
  merchantId: idSchema,
  startsAt: timestampSchema,
  endsAt: timestampSchema,
  customerSuppliedParts: z.boolean(),
}).refine(value => Date.parse(value.startsAt) < Date.parse(value.endsAt), "Засварын цагийн хуваарь буруу байна.");

export const availabilityRequestSchema = z.strictObject({
  selections: z.array(quoteSelectionSchema).min(1).max(20),
});
export const availabilityResultSchema = z.strictObject({
  available: z.boolean(),
  checkedAt: timestampSchema,
  quotes: z.array(quoteSchema),
  total: moneySchema,
  issues: z.array(z.string().min(1)),
  bookingWindows: z.array(bookingTermsSchema),
});

export const approvalIntentRequestSchema = z.strictObject({
  transactionId: idSchema,
  selections: z.array(quoteSelectionSchema).min(1).max(20),
  approvedTotal: moneySchema.refine(value => value.currency === "MNT" && value.amountMinor > 0 && value.amountMinor % 100 === 0),
  booking: bookingTermsSchema.optional(),
  expiresAt: timestampSchema,
});
export const commerceApprovalSchema = z.strictObject({
  contractVersion: z.literal("1"),
  id: idSchema,
  merchantId: idSchema,
  merchantIds: z.array(idSchema).min(1).max(20),
  buyerId: idSchema,
  transactionId: idSchema,
  selections: z.array(quoteSelectionSchema).min(1).max(20),
  approvedTotal: moneySchema.refine(value => value.currency === "MNT" && value.amountMinor > 0 && value.amountMinor % 100 === 0),
  booking: bookingTermsSchema.optional(),
  status: z.enum(["pending", "verified", "expired", "revoked"]),
  createdAt: timestampSchema,
  verifiedAt: timestampSchema.optional(),
  expiresAt: timestampSchema,
  challengeHash: z.string().regex(/^[a-f0-9]{64}$/),
  verificationReference: idSchema.optional(),
}).superRefine((approval, ctx) => {
  if ((approval.status === "verified") !== Boolean(approval.verifiedAt && approval.verificationReference)) {
    ctx.addIssue({ code: "custom", message: "Баталгаажуулалтын мэдээлэл тохирохгүй байна." });
  }
  if (Date.parse(approval.expiresAt) <= Date.parse(approval.createdAt)) {
    ctx.addIssue({ code: "custom", message: "Зөвшөөрлийн хугацаа буруу байна." });
  }
});

export const partsOrderSchema = z.strictObject({
  contractVersion: z.literal("1"), id: idSchema, transactionId: idSchema, merchantId: idSchema, buyerId: idSchema,
  approvalId: idSchema, quoteId: idSchema, quoteRevision: z.number().int().positive(),
  lines: z.array(z.strictObject({ resourceId: idSchema, quantity: z.number().int().positive(), unitPrice: moneySchema })).min(1),
  total: moneySchema, status: z.enum(["reserved", "preparing", "ready", "completed", "cancelled", "recovery_required"]),
  createdAt: timestampSchema, updatedAt: timestampSchema,
});
export const repairBookingSchema = z.strictObject({
  contractVersion: z.literal("1"), id: idSchema, transactionId: idSchema, merchantId: idSchema, buyerId: idSchema,
  approvalId: idSchema, quoteId: idSchema, quoteRevision: z.number().int().positive(),
  serviceIds: z.array(idSchema).min(1), slotId: idSchema, startsAt: timestampSchema, endsAt: timestampSchema,
  customerSuppliedParts: z.boolean(),
  status: z.enum(["booked", "in_service", "completed", "cancelled", "recovery_required"]),
  createdAt: timestampSchema, updatedAt: timestampSchema,
});
export const mockPaymentSchema = z.strictObject({
  contractVersion: z.literal("1"), id: idSchema, transactionId: idSchema, buyerId: idSchema,
  amount: moneySchema, mode: z.literal("simulated"), provider: z.literal("mock"),
  outcome: z.enum(["succeeded", "failed"]), createdAt: timestampSchema,
}).refine(value => value.amount.currency === "MNT", "Төлбөрийг төгрөгөөр илэрхийлнэ үү.");
export const commerceTransactionSchema = z.strictObject({
  ...transactionSchema.shape,
  kind: z.enum(["parts_order", "repair_booking", "parts_and_repair"]),
  status: z.enum(["approval_pending", "approved", "reserved", "booked", "payment_pending", "confirmed",
    "payment_failed", "failed", "cancelled", "recovery_required"]),
  quoteSelections: z.array(quoteSelectionSchema).min(1).max(20),
  orderIds: z.array(idSchema),
  bookingIds: z.array(idSchema),
  paymentId: idSchema.optional(),
  progress: z.enum(["awaiting_approval", "processing", "awaiting_payment", "in_progress", "ready", "completed", "cancelled"]),
  recoveryReason: z.string().max(200).optional(),
  updatedAt: timestampSchema,
});

export const approvalPageSchema = z.strictObject({
  transactionId: idSchema,
  buyerId: idSchema,
  merchantNames: z.array(z.string().min(1)),
  selections: z.array(quoteSelectionSchema).min(1),
  total: moneySchema,
  booking: bookingTermsSchema.optional(),
  expiresAt: timestampSchema,
  status: z.enum(["pending", "verified", "expired", "revoked"]),
});

export type QuoteSelection = z.infer<typeof quoteSelectionSchema>;
export type BookingTerms = z.infer<typeof bookingTermsSchema>;
export type CommerceApproval = z.infer<typeof commerceApprovalSchema>;
export type PartsOrder = z.infer<typeof partsOrderSchema>;
export type RepairBooking = z.infer<typeof repairBookingSchema>;
export type MockPayment = z.infer<typeof mockPaymentSchema>;
export type CommerceTransaction = z.infer<typeof commerceTransactionSchema>;
export type AvailabilityResult = z.infer<typeof availabilityResultSchema>;
