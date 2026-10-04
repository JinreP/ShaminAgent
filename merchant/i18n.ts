// Human-facing merchant copy only. Contract fields, identifiers and enum values stay English.
export const fieldLabels: Record<string, string> = {
  name: "Нэр", partNumber: "Туршилтын сэлбэгийн дугаар", condition: "Төлөв", location: "Байршил",
  stock: "Нөөцийн тоо", warranty: "Баталгаа", active: "Идэвхтэй", price: "Борлуулах үнэ / ажлын хөлс",
  minimumPrice: "Хувийн доод үнэ", durationMinutes: "Хугацаа (минут)", customerSuppliedParts: "Захиалагчийн сэлбэг",
  customerPartsTerms: "Захиалагчийн сэлбэгийн нөхцөл", startsAt: "Эхлэх огноо (цагийн бүстэй ISO огноо)",
  endsAt: "Дуусах огноо (цагийн бүстэй ISO огноо)", capacity: "Цагийн багтаамж", status: "Төлөв",
  maxDiscountBps: "Хөнгөлөлтийн дээд хэмжээ (суурь нэгж; 100 = 1%)", negotiationEnabled: "Үнэ тохиролцох боломжтой",
  humanApprovalRequired: "Хүний зөвшөөрөл шаардах", capabilities: "Нийтэд харагдах боломжууд (мөр бүрд нэг)",
  maxNegotiationRounds: "Хэлэлцээний оролдлогын дээд тоо", automaticNegotiationEnabled: "Автомат хэлэлцээ зөвшөөрөх",
  negotiationTimeoutSeconds: "Хүний хариу хүлээх хугацаа (секунд)",
  make: "Үйлдвэрлэгч", model: "Загвар", generation: "Үе", yearFrom: "Эхлэх он", yearTo: "Дуусах он",
  serviceIds: "Үйлчилгээ", compatibility: "Тохирох автомашин", vehicles: "Тохирох автомашин",
};

const merchantNames: Record<string, string> = {
  "demo-prius-parts": "Приус сэлбэг — ТУРШИЛТ",
  "demo-japan-used": "Япон хуучин сэлбэг — ТУРШИЛТ",
  "demo-oem-center": "Үйлдвэрийн сэлбэгийн төв — ТУРШИЛТ",
  "demo-auto-care": "Авто арчилгаа — ТУРШИЛТ",
  "demo-quick-garage": "Шуурхай засвар — ТУРШИЛТ",
};
export function merchantName(id: string): string { return merchantNames[id] ?? "Худалдаачин"; }

const knownText: Record<string, string> = {
  "Prius Parts — SIMULATED": merchantNames["demo-prius-parts"],
  "Japan Used — SIMULATED": merchantNames["demo-japan-used"],
  "OEM Center — SIMULATED": merchantNames["demo-oem-center"],
  "Auto Care — SIMULATED": merchantNames["demo-auto-care"],
  "Quick Garage — SIMULATED": merchantNames["demo-quick-garage"],
  "Toyota Prius 30": "Тоёота Приус 30",
  "Front bumper": "Урд гупер", "front bumper": "Урд гупер",
  "Left front headlight": "Зүүн урд гэрэл", "left front headlight": "Зүүн урд гэрэл",
  "Bumper replacement": "Гупер солих", "bumper replacement": "Гупер солих",
  "Left headlight replacement": "Зүүн урд гэрэл солих", "headlight replacement": "Гэрэл солих",
  "Bumper painting": "Гупер будах", "bumper painting": "Гупер будах",
  "Ulaanbaatar — simulated demo location": "Улаанбаатар — туршилтын байршил",
  "3 months labor — simulated": "Ажлын 3 сарын баталгаа — туршилт",
  "Simulated policy: fitment inspection required; no warranty on customer-supplied parts.":
    "Туршилтын нөхцөл: сэлбэгийн тохирцыг шалгана. Захиалагчийн авчирсан сэлбэгт баталгаа өгөхгүй.",
  aftermarket: "Үйлдвэрийн бус шинэ сэлбэг", used: "Хуучин сэлбэг", oem: "Үйлдвэрийн оригинал сэлбэг",
};
export function hasCyrillic(text: string): boolean { return /[\u0400-\u04ff]/u.test(text); }
export function localizeKnownText(text: string, fallback = "Мэдээлэл"): string {
  if (knownText[text]) return knownText[text];
  const warranty = /^(\d+) months — simulated$/.exec(text);
  if (warranty) return `${warranty[1]} сарын баталгаа — туршилт`;
  return hasCyrillic(text) ? text : fallback;
}

const statusLabels: Record<string, string> = {
  parts: "Сэлбэг", repair: "Засвар", parts_order: "Сэлбэгийн захиалга", repair_booking: "Засварын цаг захиалга",
  simulated: "Туршилт", live: "Бодит", active: "Идэвхтэй", inactive: "Идэвхгүй",
  received: "Хүлээн авсан", processing: "Боловсруулж байна", quoted: "Үнийн санал өгсөн",
  declined: "Татгалзсан", expired: "Хугацаа дууссан", offered: "Санал болгосон", superseded: "Шинэчлэгдсэн",
  withdrawn: "Цуцалсан", pending: "Хүлээгдэж байна", confirmed: "Баталгаажсан", failed: "Амжилтгүй",
  cancelled: "Цуцалсан", available: "Боломжтой", blocked: "Хаалттай", accepted: "Зөвшөөрнө",
  inspection_required: "Шалгах шаардлагатай", not_accepted: "Зөвшөөрөхгүй", requested: "Хүсэлт ирсэн",
  countered: "Эсрэг санал өгсөн", rejected: "Татгалзсан", verified: "Шалгаж баталгаажуулсан", revoked: "Хүчингүй болгосон",
  approval_pending: "Хэрэглэгчийн зөвшөөрөл хүлээж байна", approved: "Зөвшөөрсөн", reserved: "Нөөцөлсөн",
  booked: "Цаг захиалсан", payment_pending: "Туршилтын төлбөр хүлээж байна", payment_failed: "Туршилтын төлбөр амжилтгүй",
  recovery_required: "Сэргээх ажиллагаа шаардлагатай", awaiting_approval: "Зөвшөөрөл хүлээж байна",
  awaiting_payment: "Төлбөр хүлээж байна", in_progress: "Гүйцэтгэж байна", ready: "Бэлэн",
  in_service: "Засварлаж байна", preparing: "Бэлтгэж байна", completed: "Дууссан",
  succeeded: "Амжилттай",
  aftermarket: knownText.aftermarket, used: knownText.used, oem: knownText.oem, any: "Аль ч төрөл",
};
export function statusLabel(status: string): string { return statusLabels[status] ?? "Төлөв тодорхойгүй"; }
export const policyLabel = statusLabel;

export function localizedFieldPath(path: string): string {
  return path.split(".").map(segment => fieldLabels[segment] ?? (/^\d+$/.test(segment) ? String(Number(segment) + 1) : "Талбар")).join(" · ");
}
export function validationMessage(message: string): string {
  return hasCyrillic(message) ? message : "Утга буруу байна. Шаардлагатай төрөл, хэмжээ болон огноог шалгана уу.";
}

// Legacy exceptions remain readable by developer diagnostics; only safe Mongolian text crosses the UI boundary.
export function merchantErrorMessage(message: string): string {
  if (hasCyrillic(message)) return message;
  if (message.includes("configuration is incomplete")) return "Туршилтын тохиргоо дутуу байна. Хөгжүүлэгч тохиргоог шалгана уу.";
  if (message.includes("demo is disabled")) return "Худалдаачны туршилтын хандалт хаалттай байна. Бодит орчны нэвтрэлт хараахан хэрэгжээгүй.";
  if (message.includes("changed. Reload")) return "Бүртгэл өөрчлөгдсөн байна. Хадгалахаасаа өмнө дахин ачаална уу.";
  if (message.includes("seed before") || message.includes("Seeded simulated profile")) return "Худалдаачны туршилтын өгөгдөл бэлэн биш байна. Хөгжүүлэгч өгөгдлийн тохиргоог шалгана уу.";
  if (message.includes("denied") || message.includes("scope") || message.includes("Unknown simulated")) return "Энэ худалдаачны мэдээлэлд хандах эрхгүй байна.";
  if (message.includes("origin") || message.includes("host")) return "Туршилтын хүсэлтийн эх хаяг зөвшөөрөгдөөгүй байна.";
  if (message.includes("Request too large")) return "Хүсэлтийн хэмжээ хэтэрсэн байна.";
  if (message.includes("JSON")) return "Хүсэлтийн өгөгдлийн бүтэц буруу байна.";
  return "Үйлдэл амжилтгүй боллоо. Хандалтын эрх, мэдээлэл болон өгөгдлийн сангийн тохиргоог шалгана уу.";
}

/** Applies only to newly saved administrative copy; stored legacy records remain readable. */
export function localizedAdminFields(record: Record<string, unknown>, resource: string): string[] {
  const fields = resource === "profile" ? ["name", "location"] : resource === "inventory" ? ["name", "warranty"] :
    resource === "service" ? ["name", "warranty", "customerPartsTerms"] : [];
  const invalid = fields.filter(field => typeof record[field] === "string" && !hasCyrillic(record[field] as string));
  if (resource === "profile" && Array.isArray(record.capabilities) && record.capabilities.some(value =>
    typeof value === "string" && !hasCyrillic(value) && value !== "Toyota Prius 30")) invalid.push("capabilities");
  return invalid;
}
