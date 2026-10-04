// Public names and IDs only. No inventory, pricing or access credentials.
import { merchantName } from "./i18n";

export const DEMO_MERCHANTS = [
  { id: "demo-prius-parts", name: merchantName("demo-prius-parts"), kind: "parts" },
  { id: "demo-japan-used", name: merchantName("demo-japan-used"), kind: "parts" },
  { id: "demo-oem-center", name: merchantName("demo-oem-center"), kind: "parts" },
  { id: "demo-auto-care", name: merchantName("demo-auto-care"), kind: "repair" },
  { id: "demo-quick-garage", name: merchantName("demo-quick-garage"), kind: "repair" },
] as const;
