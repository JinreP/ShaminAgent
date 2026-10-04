import { NextRequest } from "next/server";
import { MerchantAdminStore } from "@/merchant/server/admin-store";
import { getMerchantClient, getMerchantDb } from "@/merchant/server/database";
import { demoConfig, requireDemoOrigin, MerchantAccessError } from "@/merchant/server/demo-auth";
import { apiError, json, privateMerchant, requestBody } from "@/merchant/server/http";
import { saveRequestSchema, adminSchemas } from "@/merchant/private-contracts";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const merchantId = privateMerchant(request);
    const store = new MerchantAdminStore(await getMerchantClient(), await getMerchantDb(), merchantId);
    return json(await store.snapshot());
  } catch (error) { return apiError(error); }
}
export async function PUT(request: NextRequest) {
  try {
    requireDemoOrigin(request, demoConfig());
    const merchantId = privateMerchant(request);
    const body = saveRequestSchema.parse(await requestBody(request));
    const record = adminSchemas[body.resource].parse(body.record);
    if (record.merchantId !== merchantId || record.mode !== "simulated") throw new MerchantAccessError("Merchant scope mismatch", 403);
    const store = new MerchantAdminStore(await getMerchantClient(), await getMerchantDb(), merchantId);
    await store.save(body.resource, record, body.expectedVersion);
    return json({ saved: true });
  } catch (error) { return apiError(error); }
}
