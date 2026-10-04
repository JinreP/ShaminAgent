import { NextRequest } from "next/server";
import { z } from "zod";
import { idSchema } from "@/shared/merchant-contracts";
import { CommerceStore, CommerceStoreError } from "@/merchant/commerce/store";
import { getMerchantClient, getMerchantDb } from "@/merchant/server/database";
import { demoConfig, MerchantAccessError, requireDemoOrigin } from "@/merchant/server/demo-auth";
import { apiError, json, privateMerchant, requestBody } from "@/merchant/server/http";

export const runtime = "nodejs";

const progressRequestSchema = z.strictObject({
  kind: z.enum(["order", "booking"]),
  entityId: idSchema,
  status: z.enum(["preparing", "ready", "completed", "in_service"]),
});

export async function PATCH(request: NextRequest) {
  try {
    requireDemoOrigin(request, demoConfig());
    const merchantId = privateMerchant(request);
    const input = progressRequestSchema.parse(await requestBody(request));
    if ((input.kind === "order" && input.status === "in_service") ||
        (input.kind === "booking" && ["preparing", "ready"].includes(input.status))) {
      throw new MerchantAccessError("Захиалгын төрөлд тохирохгүй төлөв байна.", 400);
    }
    const store = new CommerceStore(await getMerchantClient(), await getMerchantDb());
    await store.updateMerchantProgress(merchantId, input.entityId, input.kind, input.status);
    return json({ updated: true });
  } catch (error) {
    if (error instanceof CommerceStoreError) {
      const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : error.code === "unauthorized" ? 403 : 400;
      return json({ error: error.message }, status);
    }
    return apiError(error);
  }
}
