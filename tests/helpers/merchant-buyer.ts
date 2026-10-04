// Isolated protocol test client. This is not imported by the production Buyer application.
import { randomUUID } from "node:crypto";
import { ClientFactory, JsonRpcTransportFactory, type Client } from "@a2a-js/sdk/client";
import { SendMessageRequest } from "@a2a-js/sdk";
import { merchantRFQResponseSchema, type MerchantRFQEnvelope } from "../../merchant/a2a/contracts";

export async function merchantBuyerClient(cardURL: string, token: string): Promise<Client> {
  const authenticatedFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: authenticatedFetch })] }).createFromUrl(cardURL, "");
}
export async function sendMerchantRFQ(client: Client, envelope: MerchantRFQEnvelope) {
  const result = await client.sendMessage(SendMessageRequest.fromJSON({
    message: { messageId: randomUUID(), role: "ROLE_USER", parts: [{ data: envelope, mediaType: "application/json" }] },
  }));
  if (!("parts" in result)) throw new Error("Үнийн саналын мессеж хүлээж байсан.");
  const part = result.parts[0];
  if (part?.content?.$case !== "data") throw new Error("Бүтэцтэй үнийн санал хүлээж байсан.");
  return merchantRFQResponseSchema.parse(part.content.value);
}
