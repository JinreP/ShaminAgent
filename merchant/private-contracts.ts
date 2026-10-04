// Merchant administration only; these schemas are not Buyer discovery payloads.
import { z } from "zod";
import { idSchema, timestampSchema, moneySchema, merchantProfileSchema, type RFQ, type Quote, type Transaction } from "../shared/merchant-contracts";
import type { PartsOrder, RepairBooking } from "./commerce/contracts";

export type DashboardCommerceTransaction = {
  id: string;
  kind: "parts_order" | "repair_booking" | "parts_and_repair";
  status: "approval_pending" | "approved" | "reserved" | "booked" | "payment_pending" | "confirmed" |
    "payment_failed" | "failed" | "cancelled" | "recovery_required";
  progress: "awaiting_approval" | "processing" | "awaiting_payment" | "in_progress" | "ready" | "completed" | "cancelled";
  updatedAt: string;
  paymentId?: string;
};

const base = { contractVersion: z.literal("1"), id: idSchema, merchantId: idSchema,
  createdAt: timestampSchema, mode: z.literal("simulated") };
const text = z.string().trim().min(1).max(500);
const compatibleVehicle = z.strictObject({ make: text, model: text, generation: text,
  yearFrom: z.number().int().min(1886).max(2100), yearTo: z.number().int().min(1886).max(2100),
}).refine(v => v.yearFrom <= v.yearTo, "Тохирох автомашины эхлэх он дуусах оноос хэтэрч болохгүй.");
function validMinimum(v: { price: { amountMinor: number; currency: string }; minimumPrice: { amountMinor: number; currency: string } }) {
  return v.price.currency === v.minimumPrice.currency && v.minimumPrice.amountMinor <= v.price.amountMinor;
}
export const inventorySchema = z.strictObject({ ...base, name: text, partNumber: text,
  condition: z.enum(["oem", "aftermarket", "used"]), compatibility: z.array(compatibleVehicle).min(1).max(50),
  price: moneySchema, minimumPrice: moneySchema, stock: z.number().int().min(0).max(100000),
  warranty: text, active: z.boolean(),
}).refine(validMinimum, "Доод үнэ ижил валюттай байх ба борлуулах үнээс хэтэрч болохгүй.");
export const serviceSchema = z.strictObject({ ...base, name: text,
  vehicles: z.array(compatibleVehicle).min(1).max(50), price: moneySchema, minimumPrice: moneySchema,
  durationMinutes: z.number().int().min(15).max(10080), warranty: text, active: z.boolean(),
  customerSuppliedParts: z.enum(["accepted", "inspection_required", "not_accepted"]),
  customerPartsTerms: text,
}).refine(validMinimum, "Доод үнэ ижил валюттай байх ба ажлын хөлснөөс хэтэрч болохгүй.");
export const slotSchema = z.strictObject({ ...base, serviceIds: z.array(idSchema).min(1).max(50),
  startsAt: timestampSchema, endsAt: timestampSchema, capacity: z.number().int().min(1).max(100),
  status: z.enum(["available", "blocked"]),
}).refine(v => Date.parse(v.startsAt) < Date.parse(v.endsAt), "Цагийн төгсгөл эхлэх цагаас хойш байх ёстой.");
export const settingsSchema = z.strictObject({ ...base, maxDiscountBps: z.number().int().min(0).max(10000),
  negotiationEnabled: z.boolean(), humanApprovalRequired: z.boolean(),
  maxNegotiationRounds: z.number().int().min(1).max(20).default(3),
  automaticNegotiationEnabled: z.boolean().default(false),
  negotiationTimeoutSeconds: z.number().int().min(30).max(3600).default(300),
}).refine(v => v.id === v.merchantId, "Тохиргооны дугаар худалдаачны дугаартай ижил байх ёстой.");
export const adminSchemas = { profile: merchantProfileSchema, inventory: inventorySchema,
  service: serviceSchema, slot: slotSchema, settings: settingsSchema };
export type AdminResource = keyof typeof adminSchemas;
export type AdminRecord<K extends AdminResource = AdminResource> = z.infer<(typeof adminSchemas)[K]>;
export type Versioned<K extends AdminResource = AdminResource> = { record: AdminRecord<K>; version: number };
export const saveRequestSchema = z.strictObject({ resource: z.enum(["profile", "inventory", "service", "slot", "settings"]),
  expectedVersion: z.number().int().nonnegative(), record: z.unknown(),
});
export type DashboardSnapshot = {
  merchantId: string; profile: Versioned<"profile">; inventory: Versioned<"inventory">[];
  services: Versioned<"service">[]; slots: Versioned<"slot">[]; settings: Versioned<"settings"> | null;
  rfqs: RFQ[]; quotes: Quote[]; transactions: Transaction[];
  commerceOrders: (PartsOrder & { payment: "pending" | "succeeded" | "failed" })[];
  commerceBookings: (RepairBooking & { payment: "pending" | "succeeded" | "failed" })[];
  commerceTransactions: DashboardCommerceTransaction[];
};
