import { z } from "zod";
import { idSchema, moneySchema, negotiationSchema, quoteSchema, timestampSchema } from "../../shared/merchant-contracts";

export const negotiationPriceSchema = moneySchema.refine(price => price.currency === "MNT" &&
  price.amountMinor > 0 && price.amountMinor % 100 === 0, "Үнийг бүхэл төгрөгөөр, эерэг дүнгээр бичнэ үү.");
const incomingNegotiationSchema = negotiationSchema.refine(negotiation => negotiation.status === "requested" &&
  negotiation.responseTotal === undefined, "Шинэ үнэ тохиролцох хүсэлт шийдвэрлэгдээгүй байх ёстой.")
  .refine(negotiation => negotiationPriceSchema.safeParse(negotiation.requestedTotal).success,
    "Үнийг бүхэл төгрөгөөр, эерэг дүнгээр бичнэ үү.");
export const negotiateQuoteRequestSchema = z.strictObject({ contractVersion: z.literal("1"), action: z.literal("negotiate_quote"),
  rfqId: idSchema, correlationId: idSchema, expiresAt: timestampSchema, negotiation: incomingNegotiationSchema,
}).refine(request => Date.parse(request.expiresAt) > Date.parse(request.negotiation.createdAt),
  "Үнэ тохиролцох хүсэлтийн хүчинтэй хугацаа үүссэн хугацаанаас хойш байх ёстой.");
export const getNegotiationResultRequestSchema = z.strictObject({ contractVersion: z.literal("1"), action: z.literal("get_negotiation_result"),
  rfqId: idSchema, negotiationId: idSchema });
export const negotiationCodeSchema = z.enum(["stale_quote", "quote_expired", "rfq_expired", "negotiation_disabled", "round_limit",
  "negotiation_pending", "price_rejected", "merchant_rejected", "merchant_timeout", "availability_changed", "invalid_price"]);
export const negotiationServiceWindowSchema = z.strictObject({ startsAt: timestampSchema, endsAt: timestampSchema })
  .refine(window => Date.parse(window.startsAt) < Date.parse(window.endsAt), "Засварын цагийн төгсгөл эхлэх хугацаанаас хойш байна.");
export const responseNegotiationResponseSchema = z.strictObject({ contractVersion: z.literal("1"), merchantId: idSchema,
  rfqId: idSchema, negotiationId: idSchema, correlationId: idSchema, negotiation: negotiationSchema,
  outcome: z.enum(["pending", "accepted", "countered", "rejected"]), message: z.string().min(1), expiresAt: timestampSchema,
  round: z.number().int().nonnegative(), code: negotiationCodeSchema.optional(), quote: quoteSchema.optional(),
  serviceWindow: negotiationServiceWindowSchema.optional(),
}).superRefine((response, context) => {
  const negotiation = response.negotiation, quote = response.quote;
  const invalid = () => context.addIssue({ code: "custom", message: "Үнэ тохиролцох хүсэлтийн үр дүнгийн бүтэц тохирохгүй байна." });
  if (response.merchantId !== negotiation.merchantId || response.negotiationId !== negotiation.id ||
      Date.parse(response.expiresAt) <= Date.parse(negotiation.createdAt)) invalid();
  if (response.outcome === "pending") {
    if (negotiation.status !== "requested" || negotiation.responseTotal !== undefined || quote || response.serviceWindow) invalid();
  } else if (response.outcome === "rejected") {
    if (negotiation.status !== "rejected" || quote || response.serviceWindow) invalid();
  } else {
    if (negotiation.status !== response.outcome || !quote || !negotiation.responseTotal) { invalid(); return; }
    if (quote.merchantId !== response.merchantId || quote.rfqId !== response.rfqId || quote.buyerId !== negotiation.buyerId ||
        quote.total.currency !== negotiation.responseTotal.currency || quote.total.amountMinor !== negotiation.responseTotal.amountMinor ||
        quote.revision <= negotiation.quoteRevision || quote.reservation !== false) invalid();
    if (response.outcome === "accepted" && (negotiation.requestedTotal.currency !== quote.total.currency ||
        negotiation.requestedTotal.amountMinor !== quote.total.amountMinor)) invalid();
    if (response.serviceWindow && quote.kind !== "repair") invalid();
  }
});
export const negotiationResponseSchema = responseNegotiationResponseSchema;
export type NegotiationRequest = z.infer<typeof negotiateQuoteRequestSchema>;
export type GetNegotiationResultRequest = z.infer<typeof getNegotiationResultRequestSchema>;
export type NegotiationResponse = z.infer<typeof responseNegotiationResponseSchema>;
export type NegotiationCode = z.infer<typeof negotiationCodeSchema>;
export type NegotiationServiceWindow = z.infer<typeof negotiationServiceWindowSchema>;
