import "server-only";
import { createHash } from "node:crypto";
import { quoteSchema, type Quote, type RFQ } from "../../shared/merchant-contracts";
import { localizeKnownText, policyLabel } from "../i18n";
import type { MerchantRFQData } from "./store";
import { merchantRFQResponseSchema, type MerchantRFQEnvelope, type MerchantRFQResponse } from "./contracts";

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function vehicleMatches(vehicle: RFQ["vehicle"], compatible: MerchantRFQData["inventory"][number]["compatibility"][number]): boolean {
  const make = normalize(vehicle.make), model = normalize(vehicle.model);
  const expectedMake = normalize(compatible.make), expectedModel = normalize(compatible.model);
  const makeMatches = make === expectedMake || (expectedMake === "toyota" && ["тоёота", "тойота"].includes(make));
  const modelMatches = model === expectedModel || model === `${expectedModel}${normalize(compatible.generation)}` ||
    (expectedModel === "prius" && ["приус", `приус${normalize(compatible.generation)}`].includes(model));
  // A generation-specific RFQ or an explicit compatible year is needed to avoid ambiguous Prius generations.
  const generationKnown = model.endsWith(normalize(compatible.generation)) || vehicle.year !== undefined;
  return makeMatches && modelMatches && generationKnown &&
    (vehicle.year === undefined || (vehicle.year >= compatible.yearFrom && vehicle.year <= compatible.yearTo));
}
type Capability = "bumper" | "headlight" | "bumper_replacement" | "headlight_replacement" | "bumper_painting";
function capability(description: string, kind: RFQ["kind"]): Capability | undefined {
  const text = description.toLowerCase();
  const bumper = /bumper|гупер/.test(text), headlight = /headlight|гэрэл/.test(text);
  const painting = /paint|буд/.test(text), replacement = /replace|replacement|солих|соль/.test(text);
  if (kind === "parts") {
    if (painting || replacement) return undefined;
    if (bumper && !/rear|хойд/.test(text)) return "bumper";
    if (headlight && !/right|баруун|rear|хойд/.test(text)) return "headlight";
  } else {
    if (bumper && painting) return "bumper_painting";
    if (bumper && replacement) return "bumper_replacement";
    if (headlight && replacement && !/right|баруун|rear|хойд/.test(text)) return "headlight_replacement";
  }
  return undefined;
}
const descriptions: Record<Capability, string> = {
  bumper: "Урд гупер", headlight: "Зүүн урд гэрэл", bumper_replacement: "Гупер солих",
  headlight_replacement: "Зүүн урд гэрэл солих", bumper_painting: "Гупер будах",
};

/** Deterministic quotes use stored prices and availability. No provider can invent prices or reserve resources. */
export function calculateMerchantRFQ(merchantId: string, envelope: MerchantRFQEnvelope, data: MerchantRFQData, now: Date): MerchantRFQResponse {
  const rfq = envelope.rfq;
  const base = { contractVersion: "1" as const, merchantId, rfqId: rfq.id, correlationId: envelope.correlationId };
  const decline = (code: MerchantRFQResponse["issues"][number]["code"], message: string, outcome: "declined" | "expired" = "declined") =>
    merchantRFQResponseSchema.parse({ ...base, outcome, message, issues: [{ code, message }] });
  if (Date.parse(envelope.expiresAt) <= now.getTime() || (rfq.requiredBy && Date.parse(rfq.requiredBy) <= now.getTime()))
    return decline("rfq_expired", "Хүсэлтийн хүчинтэй хугацаа дууссан байна.", "expired");
  if (!data.profile || !data.profile.active || data.profile.mode !== "simulated")
    return decline("merchant_rejected", "Худалдаачин одоогоор хүсэлт хүлээн авах боломжгүй байна.");
  if (data.profile.id !== merchantId || data.profile.merchantId !== merchantId || rfq.merchantId !== merchantId ||
      [...data.inventory, ...data.services, ...data.slots].some(r => r.merchantId !== merchantId))
    throw new Error("Худалдаачны өгөгдлийн хүрээ зөрж байна.");
  if (data.profile.kind !== rfq.kind) return decline("unsupported_capability", "Энэ худалдаачин хүссэн төрлийн үйлчилгээ үзүүлэхгүй байна.");
  if (!data.profile.capabilities.some(c => /(?:prius|приус)\s*30/i.test(c)))
    return decline("unsupported_vehicle", "Худалдаачин энэ автомашины загварыг дэмжихгүй байна.");
  const resources = rfq.kind === "parts" ? data.inventory : data.services;
  const compatibleResources = resources.filter(r => r.active &&
    ("compatibility" in r ? r.compatibility : r.vehicles).some(v => vehicleMatches(rfq.vehicle, v)));
  if (!compatibleResources.length) return decline("unsupported_vehicle", "Энэ автомашинд тохирох сэлбэг эсвэл үйлчилгээ бүртгэгдээгүй байна.");
  const supported = new Set(data.profile.capabilities.map(c => capability(c, rfq.kind)).filter(Boolean));
  const lines: Quote["lines"] = [], issues: MerchantRFQResponse["issues"] = [], publicTerms: string[] = [];
  const quantities = new Map<string, number>();
  let durationMinutes = 0;
  for (const [itemIndex, item] of rfq.items.entries()) {
    const wanted = capability(item.description, rfq.kind);
    const candidates = compatibleResources.filter(resource => {
      const actual = capability(resource.name, rfq.kind);
      if (!actual || !supported.has(actual)) return false;
      if (rfq.kind === "parts" && "partNumber" in resource && item.partNumber) {
        if (item.partNumber !== resource.partNumber) return false;
      } else if (!wanted || wanted !== actual) return false;
      return !("condition" in resource) || !item.preference || item.preference === "any" || resource.condition === item.preference;
    }).sort((a, b) => a.id.localeCompare(b.id));
    const remaining = (r: typeof candidates[number]) => "stock" in r ? Math.max(0, r.stock - (quantities.get(r.id) ?? 0)) : Infinity;
    const sufficient = candidates.find(r => remaining(r) >= item.quantity);
    if (!candidates.length) {
      issues.push({ code: "item_unavailable", itemIndex, message: "Хүссэн сэлбэг эсвэл үйлчилгээ худалдаачинд бүртгэгдээгүй байна." });
      continue;
    }
    let needed = item.quantity;
    const allocations = sufficient ? [sufficient] : candidates.sort((a, b) => remaining(b) - remaining(a) || a.id.localeCompare(b.id));
    for (const resource of allocations) {
      const quantity = Math.min(needed, remaining(resource));
      if (!quantity) continue;
      needed -= quantity;
      quantities.set(resource.id, (quantities.get(resource.id) ?? 0) + quantity);
      const actual = capability(resource.name, rfq.kind)!;
      lines.push({ resourceId: resource.id, description: descriptions[actual], quantity, unitPrice: resource.price });
      publicTerms.push(`${descriptions[actual]}: ${localizeKnownText(resource.warranty, "Баталгааны нөхцөлийг худалдаачнаас тодруулна уу.")}`);
      if ("durationMinutes" in resource) {
        durationMinutes += resource.durationMinutes * quantity;
        publicTerms.push(`Захиалагчийн сэлбэг: ${policyLabel(resource.customerSuppliedParts)}. ${localizeKnownText(resource.customerPartsTerms, "Сэлбэгийн нөхцөлийг худалдаачнаас тодруулна уу.")}`);
      }
      if (!needed) break;
    }
    if (needed) issues.push({ code: "insufficient_stock", itemIndex, message: `Хүссэн ${item.quantity} ширхгээс ${item.quantity - needed} ширхэг боломжтой байна.` });
  }
  if (!lines.length) return merchantRFQResponseSchema.parse({ ...base, outcome: "declined", message: "Хүссэн бараа, үйлчилгээгээр үнийн санал гаргах боломжгүй байна.", issues });
  let serviceWindow: MerchantRFQResponse["serviceWindow"];
  if (rfq.kind === "repair") {
    const slot = data.slots.filter(s => s.status === "available" && s.capacity > 0 && Date.parse(s.startsAt) > now.getTime() &&
      (!rfq.requiredBy || Date.parse(s.endsAt) <= Date.parse(rfq.requiredBy)) &&
      Date.parse(s.endsAt) - Date.parse(s.startsAt) >= durationMinutes * 60000 && lines.every(l => s.serviceIds.includes(l.resourceId)))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id))[0];
    if (!slot) return decline("no_repair_slot", "Хүссэн үйлчилгээнд тохирох сул цаг алга байна.");
    serviceWindow = { startsAt: slot.startsAt, endsAt: slot.endsAt };
  }
  const quoteId = `q-${createHash("sha256").update(`${merchantId}:${rfq.id}`).digest("hex").slice(0, 48)}`;
  const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice.amountMinor, 0);
  const createdAt = now.toISOString();
  const quote = quoteSchema.parse({ contractVersion: "1", id: quoteId, merchantId, createdAt, rfqId: rfq.id, buyerId: rfq.buyerId,
    revision: 1, kind: rfq.kind, mode: "simulated", lines, total: { amountMinor: total, currency: lines[0].unitPrice.currency },
    expiresAt: new Date(Math.min(Date.parse(envelope.expiresAt), now.getTime() + 15 * 60000,
      serviceWindow ? Date.parse(serviceWindow.startsAt) : Infinity, rfq.requiredBy ? Date.parse(rfq.requiredBy) : Infinity)).toISOString(),
    availabilityCheckedAt: createdAt, reservation: false, status: "offered",
    terms: `ТУРШИЛТЫН ҮНИЙН САНАЛ. Бараа, засварын цаг захиалаагүй. Захиалга хийхээс өмнө боломжийг дахин шалгана. ${[...new Set(publicTerms)].join(" ")}`.slice(0, 4000),
  });
  return merchantRFQResponseSchema.parse({ ...base, outcome: issues.length ? "partial" : "quoted",
    message: issues.length ? "Хүсэлтийн боломжтой хэсэгт үнийн санал гаргалаа." : "Үнийн санал бэлэн боллоо. Бараа, засварын цаг захиалаагүй.",
    issues, quote, ...(serviceWindow ? { serviceWindow } : {}) });
}
