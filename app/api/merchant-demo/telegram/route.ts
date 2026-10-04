import { NextRequest } from "next/server";
import { TelegramBotAPI, TelegramAPIError } from "@/merchant/telegram/api";
import { readTelegramConfig } from "@/merchant/telegram/config";
import { TelegramMerchantStore, TelegramStoreError } from "@/merchant/telegram/store";
import { getMerchantClient, getMerchantDb } from "@/merchant/server/database";
import { MerchantAccessError, demoConfig, requireDemoOrigin } from "@/merchant/server/demo-auth";
import { apiError, json, privateMerchant } from "@/merchant/server/http";

export const runtime = "nodejs";

function authenticatedMerchant(request: NextRequest, write = false) {
  const demo = demoConfig();
  if (write) requireDemoOrigin(request, demo);
  return privateMerchant(request);
}

function demoTelegramConfig() {
  const telegram = readTelegramConfig();
  if (telegram.merchantAuthMode !== "demo" || !telegram.demoEnabled)
    throw new MerchantAccessError("Телеграмын туршилтын холболт идэвхгүй байна.", 403);
  return telegram;
}

function errorResponse(error: unknown) {
  if (error instanceof TelegramStoreError)
    return json({ error: error.message }, error.code === "binding_conflict" ? 409 : 400);
  if (error instanceof TelegramAPIError)
    return json({ error: error.message }, error.code === "unauthorized" ? 503 : 502);
  return apiError(error);
}

export async function GET(request: NextRequest) {
  try {
    const merchantId = authenticatedMerchant(request);
    const store = new TelegramMerchantStore(await getMerchantClient(), await getMerchantDb());
    const binding = await store.getMerchantBinding(merchantId, "demo");
    return json({ connected: Boolean(binding) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    const merchantId = authenticatedMerchant(request, true);
    const telegram = demoTelegramConfig();
    const store = new TelegramMerchantStore(await getMerchantClient(), await getMerchantDb());
    if (await store.getMerchantBinding(merchantId, "demo"))
      throw new TelegramStoreError("Телеграм бүртгэл аль хэдийн холбогдсон байна.", "binding_conflict");
    const bot = await new TelegramBotAPI(telegram.token).getMe();
    if (!bot.username) throw new MerchantAccessError("Телеграм ботын хэрэглэгчийн нэр тохируулаагүй байна.", 503);
    const invite = await store.issueDashboardInvite(merchantId, merchantId);
    return json({ deepLink: `https://t.me/${bot.username}?start=${invite.token}` });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: NextRequest) {
  try {
    const merchantId = authenticatedMerchant(request, true);
    const store = new TelegramMerchantStore(await getMerchantClient(), await getMerchantDb());
    await store.revokeMerchantBinding(merchantId, merchantId, "demo");
    return json({ connected: false });
  } catch (error) { return errorResponse(error); }
}
