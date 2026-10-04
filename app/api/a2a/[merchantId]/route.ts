import { handleMerchantA2A } from "@/merchant/a2a/transport";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ merchantId: string }> }): Promise<Response> {
  const { merchantId } = await context.params;
  return handleMerchantA2A(request, merchantId);
}
