import "server-only";
import type { ClientSession, Db, Document } from "mongodb";
import { idSchema } from "../../shared/merchant-contracts";
import { inventorySchema, serviceSchema, settingsSchema, slotSchema } from "../private-contracts";
import { publicProfile } from "../server/admin-store";
import type { HumanQuoteData } from "../telegram/validation";
import { merchantRFQEnvelopeSchema, type MerchantRFQEnvelope } from "./contracts";
import { RFQ_PROCESSING_COLLECTION } from "./store";

export class ScopedRFQDataError extends Error {
  constructor() { super("Энэ худалдаачны үнийн саналын хүсэлт олдсонгүй эсвэл хандах эрхгүй байна."); }
}
function domain(document: Document): Document {
  const { _id, _version, ...record } = document; void _id; void _version; return record;
}
/** Trusted server caller must establish buyer authorization or verified merchant binding before this read. */
export async function loadScopedRFQContext(db: Db, merchantId: string, rfqId: string, session: ClientSession,
  verifiedProcessing?: Document): Promise<{ envelope: MerchantRFQEnvelope; data: HumanQuoteData }> {
  idSchema.parse(merchantId); idSchema.parse(rfqId);
  const processing = verifiedProcessing ?? await db.collection(RFQ_PROCESSING_COLLECTION).findOne({ merchantId, id: rfqId }, { session });
  if (!processing || processing.merchantId !== merchantId || processing.id !== rfqId) throw new ScopedRFQDataError();
  const envelope = merchantRFQEnvelopeSchema.parse(processing.envelope);
  if (envelope.rfq.merchantId !== merchantId || envelope.rfq.id !== rfqId || processing.buyerId !== envelope.rfq.buyerId ||
    processing.correlationId !== envelope.correlationId) throw new ScopedRFQDataError();
  const profile = await db.collection("merchant_profiles").findOne({ merchantId, id: merchantId }, { session });
  const inventory = await db.collection("merchant_inventory").find({ merchantId }, { session }).toArray();
  const services = await db.collection("merchant_services").find({ merchantId }, { session }).toArray();
  const slots = await db.collection("merchant_slots").find({ merchantId }, { session }).toArray();
  const settings = await db.collection("merchant_settings").findOne({ merchantId, id: merchantId }, { session });
  const data: HumanQuoteData = { profile: profile ? publicProfile(profile) : null,
    inventory: inventory.map(record => inventorySchema.parse(domain(record))), services: services.map(record => serviceSchema.parse(domain(record))),
    slots: slots.map(record => slotSchema.parse(domain(record))), settings: settings ? settingsSchema.parse(domain(settings)) : null };
  if ((data.profile && data.profile.merchantId !== merchantId) || [...data.inventory, ...data.services, ...data.slots].some(record => record.merchantId !== merchantId) ||
    (data.settings && data.settings.merchantId !== merchantId)) throw new ScopedRFQDataError();
  return { envelope, data };
}
