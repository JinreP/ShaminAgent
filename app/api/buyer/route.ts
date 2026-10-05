import { NextResponse } from "next/server";
import { z } from "zod";

import {
  BuyerWorkflowError,
  validGoalSchema,
  createManualRequest,
  getRequestQuotes,
  negotiateRequest,
  confirmRequest,
} from "@/lib/buyer-store";

import { BuyerMerchantError } from "@/lib/buyer-merchant-client";

export const runtime = "nodejs";

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("draft"),
    report: z.string().trim().min(1).max(12000),
  }),

  z.object({
    action: z.literal("quotes"),
    requestId: z.string().uuid(),
    goal: validGoalSchema,
  }),

  z.object({
    action: z.literal("negotiate"),
    requestId: z.string().uuid(),
    token: z.string().uuid(),
    target: z.number().int().positive(),
  }),

  z.object({
    action: z.literal("confirm"),
    requestId: z.string().uuid(),
    token: z.string().uuid(),
    approved: z.literal(true),
    approvedTotal: z.number().finite().positive(),
  }),
]);

export async function POST(request: Request) {
  let raw: unknown;

  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Хүсэлтийн JSON буруу байна." },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(raw);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Хүсэлтийн мэдээлэл буруу эсвэл requestId дутуу байна.",
      },
      { status: 400 },
    );
  }

  const body = parsed.data;

  try {
    let result: unknown;

    switch (body.action) {
      case "draft":
        result = {
          requestId: await createManualRequest(body.report),
        };
        break;

      case "quotes":
        result = await getRequestQuotes(body.requestId, body.goal);
        break;

      case "negotiate":
        result = await negotiateRequest(
          body.requestId,
          body.token,
          body.target,
        );
        break;

      case "confirm":
        result = await confirmRequest(
          body.requestId,
          body.token,
          body.approvedTotal,
        );
        break;
    }

    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof BuyerWorkflowError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    if (error instanceof BuyerMerchantError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    console.error(
      "Buyer workflow error:",
      error instanceof Error ? error.name : "Unknown error",
    );

    return NextResponse.json(
      {
        error:
          "Buyer–Merchant хүсэлтийг боловсруулах боломжгүй байна. API тохиргоо, MongoDB болон Merchant үйлчилгээг шалгаарай.",
      },
      { status: 503 },
    );
  }
}
