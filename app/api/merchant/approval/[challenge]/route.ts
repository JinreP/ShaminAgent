import { NextRequest } from "next/server";
import { z } from "zod";
import { CommerceStore, CommerceStoreError } from "@/merchant/commerce/store";
import { getMerchantClient, getMerchantDb } from "@/merchant/server/database";
import { demoConfig, requireDemoOrigin } from "@/merchant/server/demo-auth";
import { apiError, json, requestBody } from "@/merchant/server/http";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ challenge: string }> };

async function store() {
  return new CommerceStore(await getMerchantClient(), await getMerchantDb());
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { challenge } = await context.params;
    const { page } = await (await store()).approvalPage(challenge);
    return json(page);
  } catch (error) {
    if (error instanceof CommerceStoreError) {
      const status = error.code === "not_found" ? 404 : error.code === "expired" ? 410 : 409;
      return json({ error: error.message }, status);
    }
    return apiError(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    requireDemoOrigin(request, demoConfig());
    const { challenge } = await context.params;
    const { action } = z.strictObject({ action: z.enum(["approve", "reject"]) }).parse(await requestBody(request));
    await (await store()).approveByChallenge(challenge, action);
    return json({ completed: true });
  } catch (error) {
    if (error instanceof CommerceStoreError) {
      const status = error.code === "not_found" ? 404 : error.code === "expired" ? 410 :
        error.code === "conflict" ? 409 : error.code === "stale" || error.code === "unavailable" ? 409 : 400;
      return json({ error: error.message }, status);
    }
    return apiError(error);
  }
}
