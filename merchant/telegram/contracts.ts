import { z } from "zod";
import { idSchema, moneySchema, quoteSchema, timestampSchema } from "../../shared/merchant-contracts";

export const telegramIdentitySchema = z.string().regex(/^[1-9][0-9]{0,15}$/);
export const quoteDraftSchema = z.strictObject({
  lines: z.array(z.strictObject({
    itemIndex: z.number().int().min(0).max(99), resourceId: idSchema.nullable(),
    quantity: z.number().int().positive().max(10000).nullable(), unitPrice: moneySchema.nullable(),
    condition: z.enum(["oem", "aftermarket", "used"]).nullable(), available: z.boolean().nullable(),
    warranty: z.string().max(500).nullable(),
  })).min(1).max(100), slotId: idSchema.nullable(),
});
export type QuoteDraft = z.infer<typeof quoteDraftSchema>;
export type TelegramBinding = {
  id: string; merchantId: string; chatId: string; userId: string; mode: "demo" | "production"; active: boolean;
};
export type DraftRecord = {
  id: string; merchantId: string; rfqId: string; correlationId: string; bindingId: string;
  chatId: string; userId: string; draft: QuoteDraft; status: "review" | "confirmed" | "rejected" | "superseded";
  createdAt: string; quoteId?: string; quoteRevision?: number;
};
export const quoteUpdatesRequestSchema = z.strictObject({ contractVersion: z.literal("1"), action: z.literal("get_quote_updates"),
  rfqId: idSchema, afterRevision: z.number().int().nonnegative().default(0) });
export const quoteUpdatesResponseSchema = z.strictObject({ contractVersion: z.literal("1"), action: z.literal("quote_updates"),
  merchantId: idSchema, rfqId: idSchema, correlationId: idSchema, latestRevision: z.number().int().nonnegative(),
  quotes: z.array(z.strictObject({ quote: quoteSchema, source: z.enum(["automatic", "human_confirmed", "negotiated"]),
    serviceWindow: z.strictObject({ startsAt: timestampSchema, endsAt: timestampSchema }).optional() })),
});
export type QuoteUpdatesResponse = z.infer<typeof quoteUpdatesResponseSchema>;
export const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: z.object({ message_id: z.number().int(), from: z.object({ id: z.number().int().positive(), is_bot: z.boolean().optional() }),
    chat: z.object({ id: z.number().int(), type: z.string() }), text: z.string().max(6000).optional(),
    reply_to_message: z.object({ message_id: z.number().int() }).optional() }).optional(),
  callback_query: z.object({ id: z.string().max(200), from: z.object({ id: z.number().int().positive(), is_bot: z.boolean().optional() }),
    message: z.object({ message_id: z.number().int(), chat: z.object({ id: z.number().int(), type: z.string() }) }).optional(),
    data: z.string().max(64).optional() }).optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
