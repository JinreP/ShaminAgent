# Phase 2: merchant administration

## Run locally

1. Copy `.env.example` to `.env.local`. Configure MONGODB_URI and MONGODB_DB
   for a development MongoDB replica set or development Atlas database.
2. Set MERCHANT_DEMO_ENABLED=true and MERCHANT_DEMO_ORIGIN to the exact loopback
   origin used in your browser (for example http://localhost:3000). If Next changes
   the port, update this value and restart. Remote origins are rejected.
3. Generate two distinct random values of at least 32 characters for
   MERCHANT_DEMO_ACCESS_KEY and MERCHANT_DEMO_SESSION_SECRET. One way:
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
   Run twice; save values only in the local environment, never source control.
4. Run `npm run merchant:demo:seed`. It initializes indexes and inserts five
   simulated merchant datasets in one transaction. It preserves existing edits
   when rerun and writes audit events for newly inserted records.
5. Run `npm run dev`, open `/merchant`, enter the configured demo access key
   and select a merchant. No Gemini key is needed for Phase 2 administration.

The dashboard edits public capability profiles and merchant-private inventory,
compatibility, selling/labor prices, minimum prices, stock, warranties, services,
customer-supplied parts policies, slot capacity/status and negotiation settings.
Add records or edit existing ones. Deactivate inventory/services or block slots
to remove availability without deleting history. Merchant kind and identity are
immutable. Prices are shown in major MNT units and stored as integer minor units.
Compatibility years are inclusive. Discount limits are basis points (100 = 1%).
These settings are data only; negotiation execution is not implemented.
Slots use explicit ISO timestamps with offsets; seed dates are fixed October
12–14, 2026 in UTC+08:00 and must be updated for later demos.
Slot capacity is planned availability, with no reservations or overbooking
engine in this phase. References must point to this merchant's active services.
RFQ, quote and transaction tabs read the newest 100 persisted merchant-scoped
records. They show honest empty states until later phases create records.

## Simulated merchants

- Prius Parts: aftermarket front bumper and left headlight; simulated package price 1,050,000 MNT.
- Japan Used: used front bumper and left headlight; simulated package price 900,000 MNT.
- OEM Center: OEM front bumper and left headlight; simulated package price 1,750,000 MNT.
- Auto Care: replacement and painting services; simulated total labor 500,000 MNT; customer parts require inspection.
- Quick Garage: replacement and painting services; simulated total labor 400,000 MNT; accepts customer parts with fitment inspection.

These deterministic fixtures support the existing Buyer demo scenario but are
independent records. The Buyer API, bundled quotes and demo receipts are unchanged
and do not read these records. Nothing here represents real inventory or prices.

## Access boundary

The private `/api/merchant-demo/*` routes require opt-in configuration and always
reject NODE_ENV=production, including cookies issued previously in development.
Login verifies a configured high-entropy local access key. It issues an HMAC-signed
one-hour HttpOnly SameSite=Strict cookie scoped to `/api/merchant-demo`. Merchant
scope is taken from this verified cookie; request query/body merchant IDs confer
no authority. Reads additionally check the configured host; mutations require
an exact same-origin Origin header and JSON input. Responses use no-store.
Demo switching requires an existing verified session and only allows the five
known simulated IDs. Saving to another merchant is rejected before persistence;
profiles in live mode cannot be administered through the demo service.

The local demo operator can intentionally switch among all five simulated
merchants. This is not a production multi-merchant permission model. Do not expose
the development server publicly or use the demo key for real merchants. Production
merchant identity/role authentication needs a separate adapter in a later phase.
Changing the signing secret invalidates existing cookies; logout clears this
browser's cookie. There is no server-side per-session revocation store yet.

Public discovery has no private-data joins and explicitly selects public fields.
Private data may be shown to an authenticated local demo administrator but is
never included in discovery or Buyer contracts. Audit events omit field values.
No A2A, MCP, Telegram, quote processing, negotiation execution or transaction
execution is added in this phase.

## Verification and limits

Run `npm run typecheck`, `npm run lint`, `npm test`.
Tests cover signed sessions, production/opt-in gating, origin checks, route-level
unauthorized access, merchant isolation, deterministic seed behavior, validation,
optimistic edits and audit persistence. In-memory tests exercise the real store
using a MongoDB test double; they do not prove disk persistence or real transaction
behavior. Replica-set suites are explicitly skipped without
MERCHANT_TEST_MONGODB_URI. Set that variable to a disposable replica set before
`npm test` in the shell environment (the test runner does not load `.env.local`);
each suite creates and drops a unique database. The Phase 2 integration
suite verifies edits through a new MongoDB connection, stale writes, isolation,
slot updates and idempotent seeds. No in-memory fallback runs in the application.
