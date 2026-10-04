// Isolated protocol test client. This is not imported by the production Buyer application.
import { randomUUID } from "node:crypto";
import { ClientFactory, JsonRpcTransportFactory, type Client } from "@a2a-js/sdk/client";
import { SendMessageRequest } from "@a2a-js/sdk";
import { merchantRFQResponseSchema, type MerchantRFQEnvelope } from "../../merchant/a2a/contracts";
import { quoteUpdatesResponseSchema } from "../../merchant/telegram/contracts";
import { negotiationResponseSchema, type NegotiationRequest } from "../../merchant/negotiation/contracts";

export async function sendNegotiation(client: Client, request: NegotiationRequest) {
  return sendNegotiationData(client, request);
}
export async function getNegotiationResult(client: Client, rfqId: string, negotiationId: string) {
  return sendNegotiationData(client, { contractVersion: "1", action: "get_negotiation_result", rfqId, negotiationId });
}
async function sendNegotiationData(client: Client, data: unknown) {
  const result = await client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: "ROLE_USER",
    parts: [{ mediaType: "application/json", data }] } }));
  if (!("parts" in result) || result.parts[0]?.content?.$case !== "data") throw new Error("Үнийн хэлэлцээний бүтэцтэй хариу хүлээж байсан.");
  return negotiationResponseSchema.parse(result.parts[0].content.value);
}

export async function merchantBuyerClient(cardURL: string, token: string): Promise<Client> {
  const authenticatedFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: authenticatedFetch })] }).createFromUrl(cardURL, "");
}
export async function sendQuoteUpdates(client: Client, rfqId: string, afterRevision = 0) {
  const result = await client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: "ROLE_USER",
    parts: [{ mediaType: "application/json", data: { contractVersion: "1", action: "get_quote_updates", rfqId, afterRevision } }] } }));
  if (!("parts" in result) || result.parts[0]?.content?.$case !== "data") throw new Error("Үнийн саналын шинэчлэлт хүлээж байсан.");
  return quoteUpdatesResponseSchema.parse(result.parts[0].content.value);
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
