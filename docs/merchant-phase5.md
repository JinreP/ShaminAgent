# Merchant Phase 5: A2A quote negotiation

Negotiation is an additive payload carried by the existing A2A `SendMessage`
JSON data part. The merchant endpoint, authentication, and protocol version are
unchanged. Parts and repair quotes use the same request contract.

## Submit a request

Send `action: "negotiate_quote"` to the merchant agent that returned the quote.
The authenticated Buyer Agent identity must own the RFQ. `correlationId` must
match the RFQ response, and `quoteId` plus `quoteRevision` must identify the
currently offered quote.

```json
{
  "contractVersion": "1",
  "action": "negotiate_quote",
  "rfqId": "rfq-123",
  "correlationId": "corr-rfq-123",
  "expiresAt": "2026-10-06T12:00:00Z",
  "negotiation": {
    "contractVersion": "1",
    "id": "neg-123",
    "merchantId": "demo-prius-parts",
    "buyerId": "buyer-123",
    "createdAt": "2026-10-06T11:50:00Z",
    "quoteId": "quote-123",
    "quoteRevision": 1,
    "requestedTotal": { "amountMinor": 25000000, "currency": "MNT" },
    "status": "requested"
  }
}
```

`amountMinor` follows the shared money contract: MNT amounts are expressed in
hundredths, so `25000000` means 250,000 MNT. Negotiated unit prices and totals
must resolve to whole MNT. Use a new negotiation `id` for each attempt; retrying
the same request with the same ID is idempotent.

The response has `outcome` `accepted`, `countered`, `rejected`, or `pending`.
Accepted/countered responses include a new, non-reserving `quote` revision.
Rejected responses include a Mongolian explanation and a machine-readable
`code`; they do not include private merchant pricing rules.

## Human-assisted results

When the merchant requires human approval, the initial response is `pending`.
Poll the same A2A endpoint using `SendMessage` and this JSON data part:

```json
{
  "contractVersion": "1",
  "action": "get_negotiation_result",
  "rfqId": "rfq-123",
  "negotiationId": "neg-123"
}
```

The result is scoped to the authenticated Buyer Agent and RFQ. Poll with
backoff until the result is no longer pending or its `expiresAt` is reached.
Timeouts are finalized as a rejection. Webhooks, A2A Tasks, reservations,
bookings, and payments are not required or created by this flow.

Use `get_quote_updates` to retrieve the latest quote revisions and the
negotiation history remains available as versioned quotes. Do not continue a
negotiation using a superseded quote: send the latest quote ID and revision.
The existing RFQ, quote, and `get_quote_updates` v1 contracts remain valid.

Shared TypeScript/Zod schemas are in `shared/merchant-contracts.ts` and
`merchant/negotiation/contracts.ts`. A Buyer implementation should validate
both submitted requests and A2A responses with these contracts (or an equivalent
v1 schema), keep each negotiation ID stable across retries, and treat
`reservation: false` as meaning no stock or service time has been reserved.
