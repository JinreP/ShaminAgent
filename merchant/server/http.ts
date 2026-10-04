import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { DEMO_COOKIE, demoConfig, verifyDemoSession, MerchantAccessError } from "./demo-auth";
import { EditConflictError } from "./admin-store";
import { merchantErrorMessage, validationMessage } from "../i18n";

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
export function privateMerchant(request: NextRequest) {
  const config = demoConfig();
  if (new URL(request.url).origin !== config.origin) throw new MerchantAccessError("Invalid demo host", 403);
  return verifyDemoSession(request.cookies.get(DEMO_COOKIE)?.value, config);
}
export async function requestBody(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new MerchantAccessError("JSON body required", 400);
  const text = await request.text();
  if (Buffer.byteLength(text) > 32768) throw new MerchantAccessError("Request too large", 413);
  try { return JSON.parse(text) as unknown; } catch { throw new MerchantAccessError("Invalid JSON", 400); }
}
export function apiError(error: unknown) {
  if (error instanceof MerchantAccessError) return json({ error: merchantErrorMessage(error.message) }, error.status);
  if (error instanceof EditConflictError) return json({ error: merchantErrorMessage(error.message) }, 409);
  if (error instanceof ZodError) return json({ error: "Талбарын утга буруу байна", fields: error.issues.map(i => ({ path: i.path.join("."), message: validationMessage(i.message) })) }, 400);
  // Never return MongoDB connection strings, documents or provider credentials.
  return json({ error: "Үйлдэл амжилтгүй боллоо. Хандалтын эрх, мэдээлэл болон өгөгдлийн сангийн тохиргоог шалгана уу." }, 503);
}
