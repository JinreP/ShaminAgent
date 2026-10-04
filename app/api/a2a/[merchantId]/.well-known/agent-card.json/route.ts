import { getA2AConfig } from "@/merchant/a2a/auth";
import { isA2AMerchant, merchantAgentCardJSON } from "@/merchant/a2a/cards";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ merchantId: string }> }): Promise<Response> {
  const { merchantId } = await context.params;
  if (!isA2AMerchant(merchantId)) return Response.json({ error: "Худалдаачин олдсонгүй." }, { status: 404 });
  try {
    return Response.json(merchantAgentCardJSON(merchantId, getA2AConfig().origin), {
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "A2A-Version": "1.0" },
    });
  } catch {
    return Response.json({ error: "Агентын картын тохиргоо буруу байна." }, { status: 503 });
  }
}
