import { randomUUID } from "node:crypto";
import { z } from "zod";
import { buyerGoalSchema, buyerQuoteSchema, merchantBundleSchema } from "./buyer-types";
import { merchantRFQEnvelopeSchema, type MerchantRFQResponse } from "../merchant/a2a/contracts";
import type { Quote } from "../shared/merchant-contracts";

export type BuyerGoal = z.infer<typeof buyerGoalSchema>;
export type BuyerOffer = z.infer<typeof buyerQuoteSchema> & { token: string };
export type MerchantBundle = z.infer<typeof merchantBundleSchema>;

export function toMinor(amount: number): number {
  const minor = amount * 100;
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(minor)) {
    throw new Error("Үнийг бүхэл төгрөгөөр, зөвшөөрөгдөх дүнгээр оруулна уу.");
  }
  return minor;
}
export function toMNT(quote: Quote): number {
  if (quote.total.currency !== "MNT" || quote.total.amountMinor % 100 !== 0) {
    throw new Error("Merchant үнийн валют эсвэл нэгж тохирохгүй байна.");
  }
  return quote.total.amountMinor / 100;
}

// This prototype deliberately supports the agreed full Prius repair, without
// silently omitting unknown damage or manufacturing extra repair operations.
export function buildRFQ(goal: BuyerGoal, merchantId: string, kind: "parts" | "repair",
  buyerId: string, batchId: string, now = new Date()) {
  if (!/^(?:Toyota\s+)?(?:Prius|Приус)\s*30$/i.test(goal.vehicle.trim()) ||
      goal.parts.trim() !== "Урд бампер, зүүн урд гэрэл" ||
      goal.tasks.trim() !== "Солих, бампер будах") {
    throw new Error("Merchant demo: Toyota Prius 30; сэлбэг: Урд бампер, зүүн урд гэрэл; ажил: Солих, бампер будах.");
  }
  const preference = z.enum(["Any", "OEM", "Aftermarket", "Used"]).parse(goal.preference).toLowerCase();
  const items = kind === "parts"
    ? ["Урд гупер", "Зүүн урд гэрэл"].map(description => ({ description, quantity: 1, preference }))
    : ["Гупер солих", "Зүүн урд гэрэл солих", "Гупер будах"].map(description => ({ description, quantity: 1 }));
  return merchantRFQEnvelopeSchema.parse({
    contractVersion: "1", correlationId: `corr-${batchId}-${merchantId}`,
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
    rfq: { contractVersion: "1", id: `rfq-${batchId}-${merchantId}`, merchantId, buyerId,
      createdAt: now.toISOString(), kind, vehicle: { make: "Toyota", model: "Prius 30" },
      items, budget: { amountMinor: toMinor(goal.budget), currency: "MNT" },
      requiredBy: new Date(now.getTime() + goal.days * 86_400_000).toISOString(), status: "received" },
  });
}

export function bundleOffer(goal: BuyerGoal, bundle: MerchantBundle, names: Record<string, string>,
  revision = 1, now = new Date()): BuyerOffer {
  const parts = bundle.parts.quote, repair = bundle.repair.quote;
  if (parts.kind !== "parts" || repair.kind !== "repair" || parts.buyerId !== repair.buyerId ||
      parts.mode !== "simulated" || repair.mode !== "simulated" ||
      parts.status !== "offered" || repair.status !== "offered" ||
      bundle.booking.merchantId !== repair.merchantId) throw new Error("Merchant багцын хүрээ тохирохгүй байна.");
  const partsTotal = toMNT(parts), labor = toMNT(repair);
  const total = partsTotal + labor;
  toMinor(total);
  return {
    id: `${parts.merchantId}-${repair.merchantId}`, token: randomUUID(),
    partsMerchant: names[parts.merchantId] ?? parts.merchantId,
    repairMerchant: names[repair.merchantId] ?? repair.merchantId,
    kind: goal.preference === "Any" ? ({ "demo-prius-parts": "Aftermarket", "demo-japan-used": "Used", "demo-oem-center": "OEM" }[parts.merchantId] ?? "Any") : goal.preference,
    parts: partsTotal, labor, total, days: Math.max(1, Math.ceil((Date.parse(bundle.booking.endsAt) - now.getTime()) / 86_400_000)),
    warranty: "Merchant саналын нөхцөлийг шалгана уу.", revision,
    expiresAt: Math.min(Date.parse(parts.expiresAt), Date.parse(repair.expiresAt)), goal, merchant: bundle,
  };
}

export function combineOffers(goal: BuyerGoal, responses: MerchantRFQResponse[], names: Record<string, string>) {
  // A partial quote must never be advertised as a complete repair package.
  const full = responses.filter(response => response.outcome === "quoted" && response.quote);
  const parts = full.filter(response => response.quote!.kind === "parts");
  const repairs = full.filter(response => response.quote!.kind === "repair" && response.serviceWindow);
  return parts.flatMap(part => repairs.map(repair => bundleOffer(goal, {
    parts: { quote: part.quote!, correlationId: part.correlationId },
    repair: { quote: repair.quote!, correlationId: repair.correlationId },
    booking: { merchantId: repair.merchantId, ...repair.serviceWindow!, customerSuppliedParts: true },
  }, names))).sort((a, b) => a.total - b.total);
}
