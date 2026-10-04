import { test } from "node:test";
import assert from "node:assert/strict";
import { ZodError, z } from "zod";
import { DEMO_MERCHANTS } from "../merchant/demo-merchants";
import { hasCyrillic, localizeKnownText, localizedAdminFields, merchantName, statusLabel } from "../merchant/i18n";
import { apiError } from "../merchant/server/http";
import { MerchantAccessError } from "../merchant/server/demo-auth";
import { inventorySchema } from "../merchant/private-contracts";
import { demoSeedRecords } from "../merchant/server/seed";
import { publicProfile } from "../merchant/server/admin-store";

test("all five public merchant names and seeded human descriptions are Mongolian", () => {
  assert.equal(DEMO_MERCHANTS.length, 5);
  for (const merchant of DEMO_MERCHANTS) {
    assert.ok(hasCyrillic(merchant.name));
    assert.equal(merchant.name, merchantName(merchant.id));
  }
  for (const { resource, record } of demoSeedRecords()) {
    assert.deepEqual(localizedAdminFields(record, resource), []);
  }
});

test("legacy English demo copy is localized and unknown copy uses a safe fallback", () => {
  assert.equal(localizeKnownText("Front bumper"), "Урд гупер");
  assert.equal(localizeKnownText("Left front headlight"), "Зүүн урд гэрэл");
  assert.equal(localizeKnownText("3 months — simulated"), "3 сарын баталгаа — туршилт");
  assert.ok(hasCyrillic(localizeKnownText("Simulated policy: fitment inspection required; no warranty on customer-supplied parts.")));
  assert.equal(localizeKnownText("Unknown private copy", "Бүртгэл"), "Бүртгэл");
  assert.equal(localizeKnownText("Unknown private copy", ""), "");
  assert.equal(localizeKnownText("Өөрийн тайлбар"), "Өөрийн тайлбар");
  for (const value of ["available", "blocked", "received", "quoted", "declined", "expired", "pending", "confirmed", "failed", "inspection_required", "used", "repair"])
    assert.ok(hasCyrillic(statusLabel(value)), value);
  assert.equal(statusLabel("unrecognized-internal-state"), "Төлөв тодорхойгүй");
});

test("legacy inventory stays schema-compatible while new English descriptions fail the save boundary", () => {
  const fixture = demoSeedRecords().find(record => record.resource === "inventory")!.record;
  const legacy = { ...fixture, name: "Front bumper", warranty: "3 months — simulated" };
  assert.equal(inventorySchema.safeParse(legacy).success, true);
  assert.deepEqual(localizedAdminFields(legacy, "inventory"), ["name", "warranty"]);
  assert.deepEqual(localizedAdminFields({ ...legacy, name: "Урд гупер", warranty: "3 сарын баталгаа" }, "inventory"), []);
});

test("public discovery localizes legacy seeded profiles without publishing private fields", () => {
  const fixture = demoSeedRecords().find(record => record.resource === "profile")!.record;
  const profile = publicProfile({ ...fixture, name: "Prius Parts — SIMULATED", location: "Ulaanbaatar — simulated demo location",
    capabilities: ["Toyota Prius 30", "front bumper", "aftermarket"], minimumPrice: { amountMinor: 1, currency: "MNT" } });
  assert.ok(hasCyrillic(profile.name));
  assert.ok(hasCyrillic(profile.location));
  assert.deepEqual(profile.capabilities, ["Toyota Prius 30", "Урд гупер", "Үйлдвэрийн бус шинэ сэлбэг"]);
  assert.ok(!("minimumPrice" in profile));
});

test("merchant HTTP errors localize authentication and Zod messages without driver details", async () => {
  const denied = await apiError(new MerchantAccessError()).json();
  assert.ok(hasCyrillic(denied.error));
  const validation = z.object({ stock: z.number().nonnegative() }).safeParse({ stock: -1 });
  assert.equal(validation.success, false);
  if (validation.success) return;
  assert.ok(validation.error instanceof ZodError);
  const invalid = await apiError(validation.error).json();
  assert.ok(hasCyrillic(invalid.error));
  assert.ok(hasCyrillic(invalid.fields[0].message));
  assert.equal(invalid.fields[0].path, "stock");
  const privateUri = "mongodb://private-user:private-secret@private-host/db";
  const unknown = await apiError(new Error(`Driver connection failed: ${privateUri}`)).json();
  assert.ok(hasCyrillic(unknown.error));
  assert.ok(!JSON.stringify(unknown).includes("private-"));
});
