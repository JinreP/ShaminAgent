import { NextRequest } from "next/server";
import { z } from "zod";
import { DEMO_COOKIE, DEMO_MERCHANTS, DEMO_TTL_SECONDS, demoConfig, issueDemoSession, verifyDemoKey, requireDemoOrigin } from "@/merchant/server/demo-auth";
import { apiError, json, privateMerchant, requestBody } from "@/merchant/server/http";

export const runtime = "nodejs";
const sessionRequest = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("login"), accessKey: z.string().max(512), merchantId: z.string().max(128) }),
  z.strictObject({ action: z.literal("switch"), merchantId: z.string().max(128) }),
  z.strictObject({ action: z.literal("logout") }),
]);
export async function GET(request: NextRequest) {
  try { return json({ merchantId: privateMerchant(request), merchants: DEMO_MERCHANTS, mode: "simulated" }); }
  catch (error) { return apiError(error); }
}
export async function POST(request: NextRequest) {
  try {
    const config = demoConfig();
    requireDemoOrigin(request, config);
    const body = sessionRequest.parse(await requestBody(request));
    if (body.action === "login") verifyDemoKey(body.accessKey, config);
    else privateMerchant(request);
    const response = json({ mode: "simulated" });
    response.cookies.set(DEMO_COOKIE, body.action === "logout" ? "" : issueDemoSession(body.merchantId, config), {
      httpOnly: true, sameSite: "strict", secure: config.origin.startsWith("https:"), path: "/api/merchant-demo",
      maxAge: body.action === "logout" ? 0 : DEMO_TTL_SECONDS,
    });
    return response;
  } catch (error) { return apiError(error); }
}
