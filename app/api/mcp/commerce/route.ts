import { handleCommerceMCP } from "@/merchant/commerce/mcp";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleCommerceMCP(request);
}

export async function GET(request: Request): Promise<Response> {
  return handleCommerceMCP(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handleCommerceMCP(request);
}
