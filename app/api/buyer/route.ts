import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";

const secret = process.env.DEMO_SIGNING_SECRET;

// Найзын Merchant Agent холбогдох хүртэл ашиглах demo саналууд.
const merchants = [
  {
    id: "a",
    partsMerchant: "Prius Parts",
    repairMerchant: "Auto Care",
    kind: "Aftermarket",
    parts: 1050000,
    labor: 500000,
    days: 3,
    warranty: "3 сар",
  },
  {
    id: "b",
    partsMerchant: "Japan Used",
    repairMerchant: "Quick Garage",
    kind: "Used",
    parts: 900000,
    labor: 400000,
    days: 2,
    warranty: "1 сар",
  },
  {
    id: "c",
    partsMerchant: "OEM Center",
    repairMerchant: "Auto Care",
    kind: "OEM",
    parts: 1750000,
    labor: 500000,
    days: 3,
    warranty: "6 сар",
  },
];

// Серверээс гаргасан саналд гарын үсэг үүсгэнэ.
function sign(value: object) {
  if (!secret) {
    throw new Error("DEMO_SIGNING_SECRET тохируулна уу.");
  }

  const data = Buffer.from(JSON.stringify(value)).toString("base64url");

  const signature = createHmac("sha256", secret)
    .update(data)
    .digest("base64url");

  return `${data}.${signature}`;
}

// Хэрэглэгч саналын үнэ, нөхцөлийг өөрчилсөн эсэхийг шалгана.
function verify(token: string) {
  if (!secret) {
    throw new Error("DEMO_SIGNING_SECRET тохируулна уу.");
  }

  const [data, signature] = token.split(".");

  if (!data || !signature) {
    throw new Error("Саналын token буруу.");
  }

  const expected = createHmac("sha256", secret).update(data).digest();

  const actual = Buffer.from(signature, "base64url");

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Санал өөрчлөгдсөн байна.");
  }

  const quote = JSON.parse(Buffer.from(data, "base64url").toString());

  if (quote.expiresAt < Date.now()) {
    throw new Error("Саналын хугацаа дууссан. Дахин санал авна уу.");
  }

  return quote;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // 1. Санал авах
    if (body.action === "quotes") {
      const { goal } = body;

      if (
        !goal ||
        goal.vehicle !== "Toyota Prius 30" ||
        !Number.isFinite(goal.budget) ||
        goal.budget <= 0 ||
        !Number.isInteger(goal.days) ||
        goal.days < 1 ||
        goal.days > 30 ||
        !["Any", "OEM", "Aftermarket", "Used"].includes(goal.preference)
      ) {
        throw new Error(
          "Машин, төсөв, хугацаа, сэлбэгийн сонголтоо шалгана уу.",
        );
      }

      if (
        goal.parts !== "Урд бампер, зүүн урд гэрэл" ||
        goal.tasks !== "Солих, бампер будах"
      ) {
        throw new Error(
          "Demo зөвхөн Prius 30-ийн бампер, зүүн гэрэл солих ба будах хүсэлтийг дэмжинэ.",
        );
      }

      const quotes = merchants
        .filter(
          (merchant) =>
            goal.preference === "Any" || merchant.kind === goal.preference,
        )
        .map((merchant) => {
          const offer = {
            ...merchant,
            total: merchant.parts + merchant.labor,
            goal,
            revision: 1,
            expiresAt: Date.now() + 15 * 60 * 1000,
          };

          return {
            ...offer,
            token: sign(offer),
          };
        });

      return NextResponse.json({
        quotes,
        mode: "demo",
      });
    }

    // 2. Үнэ тохиролцох
    if (body.action === "negotiate") {
      const quote = verify(body.token);

      if (quote.revision !== 1) {
        throw new Error("Demo дээр нэг удаа үнэ тохиролцоно.");
      }

      if (
        !Number.isFinite(body.target) ||
        body.target <= 0 ||
        body.target >= quote.total
      ) {
        throw new Error("Зорилтот үнэ одоогийн үнээс бага байна.");
      }

      const original = merchants.find((merchant) => merchant.id === quote.id)!;

      // Demo merchant-ийн хөнгөлөлтийн дүрэм.
      const minimumParts = Math.ceil(original.parts * 0.96);
      const minimumLabor = Math.ceil(original.labor * 0.94);

      const total = Math.max(body.target, minimumParts + minimumLabor);

      const discount = quote.total - total;

      const parts =
        original.parts - Math.min(original.parts - minimumParts, discount);

      const offer = {
        ...quote,
        parts,
        labor: total - parts,
        total,
        revision: 2,
      };

      return NextResponse.json({
        quote: {
          ...offer,
          token: sign(offer),
        },
        message:
          total <= body.target
            ? "Merchant-ууд таны үнийг зөвшөөрлөө."
            : "Merchant-ууд эсрэг санал өглөө.",
      });
    }

    // 3. Хэрэглэгчийн зөвшөөрөл → demo баримт
    if (body.action === "confirm") {
      const quote = verify(body.token);

      if (body.approved !== true || body.approvedTotal !== quote.total) {
        throw new Error("Эцсийн үнэ дээр зөвшөөрөл шаардлагатай.");
      }

      // Ижил саналыг давхар батлахад ижил дугаар гарна.
      // Энд бодит inventory, booking, payment өөрчлөхгүй.
      const id = createHmac("sha256", secret!)
        .update(body.token)
        .digest("hex")
        .slice(0, 12)
        .toUpperCase();

      return NextResponse.json({
        receipt: {
          id,
          orderId: `ORD-${id}`,
          bookingId: `BOOK-${id}`,
          paymentId: `MOCK-${id}`,
          quote,
          mode: "demo",
          status: "demo_completed",
        },
      });
    }

    throw new Error("Үйлдэл олдсонгүй.");
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Хүсэлт боловсруулахад алдаа гарлаа.",
      },
      { status: 400 },
    );
  }
}
