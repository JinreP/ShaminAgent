import { getA2AConfig } from "@/merchant/a2a/auth";
import { getA2AMerchantDirectory } from "@/merchant/a2a/cards";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    return Response.json(getA2AMerchantDirectory(getA2AConfig().origin), {
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "A2A-Version": "1.0" },
    });
  } catch {
    return Response.json({ error: "Худалдаачдын мэдээллийн тохиргоо буруу байна." }, { status: 503 });
  }
}
