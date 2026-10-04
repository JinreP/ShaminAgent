# Phase 6: MCP commerce integration

This document describes the merchant-owned commerce MCP endpoint. It does not require changes to Buyer-owned source code, but the Buyer Agent must implement the approval-link handoff and explicitly obtain the user's approval before it continues.

## Endpoint and authentication

The Streamable HTTP MCP endpoint is:

```text
POST /api/mcp/commerce
```

Use the official `@modelcontextprotocol/sdk` client and `StreamableHTTPClientTransport`. Initialize the connection, then call `tools/list` to discover the schemas and descriptions returned by the server. Keep the MCP session ID returned by initialization and send it with later requests. The current deployment stores active sessions in process memory for up to 30 minutes; a multi-instance deployment must provide session affinity or replace this store with a shared session implementation.

Configure the endpoint with:

```text
MERCHANT_MCP_ENABLED=true
MERCHANT_MCP_AUTH_MODE=token
MERCHANT_MCP_TOKEN=<random secret, at least 32 characters>
MERCHANT_MCP_BUYER_ID=<configured Buyer identity>
MERCHANT_MCP_MERCHANT_IDS=<comma-separated authorized merchant IDs>
MERCHANT_MCP_APPROVAL_ORIGIN=<application origin>
MERCHANT_MCP_ALLOWED_HOSTS=<optional comma-separated Host allowlist>
```

Send `Authorization: Bearer <MERCHANT_MCP_TOKEN>` on every request, including requests for an existing session. The server binds the token to the configured buyer and merchant scope and rejects session reuse with a different identity or token. Do not send a buyer ID or merchant scope supplied by an untrusted end user. This is a static, service-to-service bearer credential, not OAuth; provision and rotate it outside source control and use TLS when deployed.

`MERCHANT_MCP_AUTH_MODE=demo` is available only when explicitly enabled on loopback in a non-production environment. The commerce store and seeded merchant registry currently authorize the demo merchants only.

To use the demo approval page locally, also configure `MERCHANT_DEMO_ENABLED=true`, `MERCHANT_DEMO_ORIGIN` to the exact same loopback origin as `MERCHANT_MCP_APPROVAL_ORIGIN`, and separate random `MERCHANT_DEMO_ACCESS_KEY` and `MERCHANT_DEMO_SESSION_SECRET` values (each at least 32 characters). The approval decision endpoint checks the same-origin header and is disabled by the demo configuration guard in production.

## Tools and workflow

The server exposes these tools:

- `check_availability`: revalidates each quote ID and revision, expiration, current part/service pricing, inventory, and repair-slot capacity.
- `request_user_approval`: persists a pending approval bound to buyer, quote selections and revisions, merchant IDs, total in MNT, optional repair terms, transaction ID, and expiry. Returns an approval URL; it does not accept or infer an approval boolean.
- `create_parts_order`: atomically reserves stock and writes one merchant-isolated order per parts merchant.
- `book_repair`: reserves the exact approved repair slot. If this fails after parts were reserved, the workflow attempts to release those reservations.
- `mock_payment`: records an explicitly simulated success or failure. A failed mock payment triggers compensation; no real payment provider is contacted.
- `cancel_parts_order` and `cancel_repair_booking`: release eligible reservations.
- `cancel_transaction`: releases all parts and repair reservations together for a combined transaction. The individual cancellation tools reject combined carts so the Buyer cannot accidentally leave a partly cancelled purchase payable.
- `get_transaction_status`: returns the authenticated buyer's transaction, scoped orders/bookings, and mock payment result.

Expected orchestration:

1. Call `check_availability` with `selections: [{ merchantId, quoteId, quoteRevision }]`.
2. Present the exact quote revisions, total, and (for repair) chosen `booking: { merchantId, startsAt, endsAt, customerSuppliedParts }` to the user.
3. Call `request_user_approval` with those same selections and terms, `approvedTotal: { amountMinor, currency: "MNT" }`, a unique `transactionId`, and an `expiresAt`.
4. Open the returned `approvalUrl` for the user. The user must review the Mongolian confirmation page and click **Зөвшөөрөх**. The Buyer must wait for that explicit action before invoking transaction tools. **Татгалзах** revokes the approval.
5. For parts, call `create_parts_order`; for repair, call `book_repair`. For a combined purchase, create the parts order before the repair booking so a booking failure can compensate the parts reservation.
6. If the user cancels before payment, call the matching cancellation tool; for a combined purchase, call `cancel_transaction`.
7. Call `mock_payment` only after the reservations succeed. `outcome` is either `succeeded` or `failed` and always means a simulation.
8. Use `get_transaction_status` to retrieve the structured result.

The `idempotencyKey` for the transaction tools must equal the corresponding `transactionId`. Replaying an identical operation returns its existing record where possible; a transaction ID cannot be reused with different approval terms. Amounts use the shared contract's integer `amountMinor` representation and must resolve to whole MNT (multiples of 100 minor units).

MongoDB multi-document transactions protect each reservation/order or booking operation. The overall order → booking → mock-payment workflow is **not** one distributed atomic transaction; failures are handled with persisted compensations and a `recovery_required` state where automatic release fails. Do not describe it to users as an atomic transaction.

## Approval adapter boundary

No trusted Buyer approval provider is present in this repository. The current adapter is intentionally isolated as a **demo-only, explicit user-interaction flow**: it stores only a hash of a random, expiring, single-use link challenge; the user must open the merchant app's Mongolian approval page and click an action. The MCP caller cannot create a verified approval by submitting a boolean.

This link is a bearer capability, not identity verification. The current UI/API approval adapter requires the existing loopback-only merchant demo configuration and is disabled in production. Do not deploy it as a production buyer-authentication mechanism. Before production commerce, coordinate with the Buyer developer to replace it with a trusted approval assertion bound to the same transaction fields and verify it server-side.

## Persistence and merchant dashboard

Commerce approvals, transactions, orders, bookings, inventory/slot reservations, mock payments, compensation attempts, and audit events are stored in dedicated MongoDB collections. Parts orders contain only the corresponding merchant's lines and totals. The Mongolian merchant dashboard exposes that merchant's order/booking status, simulated payment state, and progress controls. Progress can be advanced only after a successful mock payment and is scoped to the authenticated merchant.

## Tests

The disposable MongoDB integration suite uses `MongoMemoryReplSet` and the official MCP SDK client. It never reads `MONGODB_URI` from the environment for its test database:

```text
MERCHANT_COMMERCE_LOCAL_INTEGRATION=true npm run test:merchant:commerce
```

The suite covers authorization and merchant scope, explicit approval, stale/expired terms, duplicate requests, concurrent stock and slot reservations, idempotent replay, compensation, mock payment failure, and MCP initialization/tool invocation. Telegram and payment providers are not contacted. Mocked or disposable infrastructure tests are not live integrations.
