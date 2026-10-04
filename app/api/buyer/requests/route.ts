import { NextResponse } from "next/server";
import { z } from "zod";

import {
  BuyerWorkflowError,
  listBuyerRequests,
  readBuyerRequest,
} from "@/lib/buyer-store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const rawId = query.get("id");

  try {
    if (rawId !== null) {
      const parsedId = z.string().uuid().safeParse(rawId);

      if (!parsedId.success) {
        return NextResponse.json(
          { error: "Хүсэлтийн дугаар буруу байна." },
          { status: 400 },
        );
      }

      const savedRequest = await readBuyerRequest(parsedId.data);

      return NextResponse.json(
        { request: savedRequest },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    }

    const requests = await listBuyerRequests();

    return NextResponse.json(
      { requests },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    if (error instanceof BuyerWorkflowError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }

    console.error(
      "Buyer requests read error:",
      error instanceof Error ? error.name : "Unknown error",
    );

    return NextResponse.json(
      {
        error: "Хадгалсан хүсэлтүүдийг уншиж чадсангүй. Дахин оролдоорой.",
      },
      { status: 503 },
    );
  }
}
