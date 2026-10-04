import "server-only";
import { AgentCard } from "@a2a-js/sdk";
import { DEMO_MERCHANTS } from "../demo-merchants";

export const A2A_PROTOCOL_VERSION = "1.0" as const;
export const A2A_AGENT_VERSION = "5.0.0" as const;

export function isA2AMerchant(merchantId: string): boolean {
  return DEMO_MERCHANTS.some(merchant => merchant.id === merchantId);
}

// Only public identity and capability information belongs in an Agent Card.
// Prices, inventory counts, booking slots and private policies are never read here.
export function getMerchantAgentCard(merchantId: string, origin: string): AgentCard {
  const merchant = DEMO_MERCHANTS.find(value => value.id === merchantId);
  if (!merchant) throw new Error("Худалдаачин олдсонгүй.");
  const parts = merchant.kind === "parts";
  const securityRequirements = [{ schemes: { merchantBearer: { list: [] } } }];
  return {
    name: merchant.name,
    description: parts
      ? "Тоёота Приус 30 автомашины сэлбэгийн хүсэлтийг өөрийн хадгалсан дуураймал өгөгдлөөр шалгаж үнийн санал гаргана. Үнийн санал нөөц захиалахгүй."
      : "Тоёота Приус 30 автомашины засварын хүсэлтийг өөрийн хадгалсан дуураймал үйлчилгээ, боломжит цагаар шалгаж үнийн санал гаргана. Үнийн санал засварын цаг захиалахгүй.",
    supportedInterfaces: [{ url: `${origin}/api/a2a/${merchant.id}`, protocolBinding: "JSONRPC", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: { organization: "ЗахАгент", url: origin },
    version: A2A_AGENT_VERSION,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false, extensions: [] },
    securitySchemes: {
      merchantBearer: { scheme: { $case: "httpAuthSecurityScheme", value: {
        scheme: "Bearer", bearerFormat: "JWT",
        description: "Худалдан авагчийн баталгаажсан эрх болон хандах худалдаачдын хүрээг агуулсан токен шаардлагатай. Туршилтын нэвтрэлт үйлдвэрлэлийн нэвтрэлтээс тусдаа.",
      } } },
    },
    securityRequirements,
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [{
      id: `${merchant.id}-${parts ? "parts-rfq" : "repair-rfq"}`,
      name: parts ? "Сэлбэгийн үнийн санал" : "Засварын үнийн санал",
      description: parts
        ? "Өөрийн сэлбэгийн тохироо, үнэ, нөөцийг шалган урд гупер болон зүүн урд гэрлийн үнийн санал гаргана."
        : "Өөрийн үйлчилгээ, хөдөлмөрийн үнэ, боломжит цагаар гупер солих, зүүн гэрэл солих, гупер будах үнийн санал гаргана.",
      tags: parts ? ["Тоёота Приус 30", "сэлбэг", "гупер", "гэрэл"] : ["Тоёота Приус 30", "засвар", "будаг"],
      examples: parts ? ["Приус 30 автомашины урд гуперийн үнийн санал авах."] : ["Приус 30 автомашины гупер солих засварын үнийн санал авах."],
      inputModes: ["application/json"], outputModes: ["application/json"], securityRequirements,
    }, {
      id: `${merchant.id}-quote-updates`, name: "Баталгаажсан үнийн саналын шинэчлэлт",
      description: "Өөрийн хүсэлтийн автомат болон хүний баталгаажуулсан саналыг хувилбараар авна. get_quote_updates бүтэцтэй хүсэлт хэрэглэнэ.",
      tags: ["үнийн санал", "шинэчлэлт"], examples: ["Миний хүсэлтийн шинэ үнийн саналыг авах."],
      inputModes: ["application/json"], outputModes: ["application/json"], securityRequirements,
    }, {
      id: `${merchant.id}-negotiation`, name: "Үнийн хэлэлцээ",
      description: "Өөрийн хүчинтэй үнийн саналд хэлэлцээ хүсэж, зөвшөөрсөн, эсрэг үнэ эсвэл татгалзсан үр дүнг авна. Хүний шийдвэрийг дараа нь шалгаж болно.",
      tags: ["үнийн хэлэлцээ", "хүний зөвшөөрөл"], examples: ["Миний хүчинтэй үнийн саналын үнийг хэлэлцэх."],
      inputModes: ["application/json"], outputModes: ["application/json"], securityRequirements,
    }],
    signatures: [],
  };
}

export function getA2AMerchantDirectory(origin: string) {
  return {
    contractVersion: "1" as const,
    protocolVersion: A2A_PROTOCOL_VERSION,
    mode: "simulated" as const,
    discovery: "public_capabilities_only" as const,
    merchants: DEMO_MERCHANTS.map(merchant => ({
      merchantId: merchant.id, kind: merchant.kind, name: merchant.name, mode: "simulated" as const,
      agentCardUrl: `${origin}/api/a2a/${merchant.id}/.well-known/agent-card.json`,
      a2aUrl: `${origin}/api/a2a/${merchant.id}`,
    })),
  };
}

export function merchantAgentCardJSON(merchantId: string, origin: string): unknown {
  return AgentCard.toJSON(getMerchantAgentCard(merchantId, origin));
}
