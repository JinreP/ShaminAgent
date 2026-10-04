import { NextResponse } from "next/server";
import { getBuyerHistory } from "@/lib/buyer-store";

export const runtime = "nodejs";

export async function GET() {
  try {
    const history = await getBuyerHistory();

    return NextResponse.json(
      { history },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error(
      "Buyer history DB error:",
      error instanceof Error
        ? `${error.name}: ${error.message}`.replace(
            /mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi,
            "[REDACTED_URI]",
          )
        : "Unknown error",
    );

    return NextResponse.json(
      { error: "MongoDB холболт амжилтгүй байна." },
      { status: 503 },
    );
  }
}
