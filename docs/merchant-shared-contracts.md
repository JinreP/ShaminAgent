# Merchant shared contracts v1

## Repository assessment

The repository is a single Next.js 16.3.8 App Router application with React 19.2.8,
TypeScript strict mode, Tailwind 4 and ESLint 9. `app/page.tsx` owns the Mongolian
Buyer demo UI and local browser receipt history. `app/api/buyer/route.ts` issues
HMAC-signed demo offers, performs one simulated negotiation and returns deterministic
demo receipts. It has no persistent inventory, approval or transaction storage.
These files and the existing layout/styles are preserved. No prior merchant services,
database configuration, shared schema package, AI integration or automated tests existed.
Public SVGs are starter assets. Next/PostCSS/TypeScript/ESLint configuration is retained.

## Buyer integration boundary

Import runtime schemas and inferred types from `shared/merchant-contracts.ts`.
This is an additive v1 contract proposal for Buyer integration review. It does not
replace the demo's inline `Goal`, bundled `Quote` or `Receipt` types. Existing
`/api/buyer` actions and response formats are unchanged. No new HTTP, A2A or MCP
endpoint is exposed in Phase 1. Later protocol adapters must carry these domain
payloads inside genuine official protocol messages, not replace protocols with JSON routes.

All records carry `contractVersion: "1"`, `id`, `merchantId`, `createdAt`.
IDs are opaque, case-sensitive ASCII letters/digits/underscore/hyphen (1–128 chars).
Timestamps are ISO 8601 strings with offsets, persisted as strings in v1.
Money uses safe integer `amountMinor` and a three-letter uppercase ISO currency
code; Buyer must agree the currency's minor-unit exponent (MNT: 2) and convert
the existing demo's major-unit values explicitly. Currency existence/exponent
validation belongs to the integration currency registry, not the regex alone.
Unknown fields are rejected. Do not silently coerce strings into prices.

- MerchantProfile: public discovery fields, parts/repair kind, capabilities, location, active flag and explicit simulated/live mode. Profile id equals merchantId.
- RFQ: a request directed to one merchant with authenticated buyerId, vehicle, item quantities, optional budget/deadline and processing status. Fan-out creates distinct merchant records.
- Quote: one merchant and RFQ, immutable revision, priced resource lines, exact total, availability timestamp, expiry, terms, mode and `reservation: false`. Total includes all priced items/fees as lines. Quotes confer no inventory or booking hold.
- Negotiation: requested amount and optional merchant response, tied to quote revision. Never include floor prices, margins, discount ceilings or internal reasoning. An accepted/countered result creates a new quote in a later phase.
- ApprovalRequest: explicit consent to quote id/revision/total and an idempotency key. It cannot assert buyer identity, verification status or server timestamps.
- Approval: server-only persistent record bound to authenticated buyer, quote revision/total, verification reference and expiry, with verified/revoked status. A valid schema is not proof of consent.
- Transaction: order or repair booking linked to persisted approval and quote revision, idempotency key, latest availability check, mode and explicit mock payment label. No execution is implemented in Phase 1.
- AuditEvent: structured actor, action, entity, correlation and outcome. No freeform payload to accidentally disclose credentials or private limits. Internal audit/approval/transaction records must never be serialized wholesale to Buyer.

## Required future transaction checks

Authenticate the buyer and derive merchant scope from trusted routing/authentication.
Load approval and quote within that scope. Check buyer, revision, amount/currency,
verification, revocation and expiry; recheck inventory or slot availability. Atomically
consume approval, write the transaction and audit, and update inventory/booking.
Handle duplicate-key conflicts by returning the original result only after confirming
the same principal and payload; reject reused keys with different input. Quote schemas,
AI output, a checkbox, a signed demo token or a client `approved: true` alone do not authorize execution.

## Persistence and isolation

`merchant/server/database.ts` provides lazy pooled connection, retry after failed
connection and explicit shutdown. `npm run merchant:db:init` loads `.env.local`
via `@next/env` and creates eleven merchant-prefixed collections and compound indexes.
Nothing connects during imports or builds. No seed inventory or merchants are inserted.
Unique keys are scoped by merchantId: record identity; quote RFQ/revision; transaction
idempotency key, approval id, and buyer/quote/revision/kind. Records and audits have
no TTL indexes: expiry must not erase evidence. Run initialization before accepting writes.

`MerchantRepository` exposes scoped reads and validated append-only audited inserts
for profiles, RFQs, quotes and negotiations. Inserts and their audit event use one
MongoDB transaction and fail closed on standalone MongoDB. Use Atlas or a replica set.
Approval writes and transaction writes are intentionally absent until verified approval
and transaction services exist. MongoDB credentials must be server-only and access
to raw DB handles restricted to trusted merchant modules. Application scoping is not
database row-level security; do not hand raw collections to request handlers or clients.

## Providers and configuration

Copy `.env.example` to `.env.local`; supply MongoDB URI/database and Gemini key/model.
Environment validation is lazy and lists invalid variable names without printing values.
No merchant variable uses NEXT_PUBLIC_. Server modules use `server-only` boundaries.
The existing DEMO_SIGNING_SECRET remains owned by the Buyer demo.

Gemini uses Google's official `@google/genai` SDK, configurable model, a 30-second
request timeout, abort support and rejects empty text. Reference:
[Google JavaScript SDK](https://googleapis.github.io/js-genai/release_docs/index.html).
Its text is advisory only; never use it as the source of inventory, prices, approval
or transaction authority. Do not pass private pricing rules into prompts exposed to Buyer.
AIProvider and SpeechProvider are replaceable interfaces. OyuLLM and Anir adapters
throw explicit not-configured errors and make no requests. Disabled speech fails
explicitly. Documented APIs and credentials are needed to implement those adapters.

## Validation

Run `npm run typecheck`, `npm test`, `npm run lint`.
Unit tests use deterministic fixtures and injected Gemini responses (no billable calls).
Optional MongoDB integration tests require MERCHANT_TEST_MONGODB_URI pointing to
a disposable replica set; they create and drop a unique test database. Never use
production credentials. Without that variable they are explicitly skipped.
Real Gemini connectivity requires credentials and is not covered by mock tests.

## Phase 2 additive changes

The public MerchantProfile schema and all Buyer RFQ/quote/approval/transaction
fields remain unchanged. Audit action values are extended with `inventory_saved`,
`service_saved`, `slot_saved`, `settings_saved`, `demo_seeded`; existing values
remain valid. Buyer consumers that exhaustively handle internal audit actions
must tolerate these additions. Private schemas in `merchant/private-contracts.ts`
are merchant administration contracts, not public A2A/discovery fields.

`GET /api/merchants/discovery?kind=parts&capability=Prius%2030` returns
`{ contractVersion: "1", merchants: MerchantProfile[], discovery: "public_capabilities_only" }`.
Both filters are optional. Only active profiles are considered, with an explicit
public-field projection and serializer. Capability filtering is a case-insensitive
substring search, not AI matching. No catalog, inventory, price, stock, floors,
discount policy or booking slots are exposed. Result limit is 100 profiles.
Mode identifies each simulated profile. This endpoint does not implement A2A.

New private collections are merchant_inventory, merchant_services, merchant_slots,
merchant_settings, all indexed uniquely by merchantId/id. Stored `_version` is
administration metadata outside shared domain records. Admin edits require the
current expectedVersion, atomically replace the scoped record and append an
allowlisted audit event. Concurrent/stale saves fail with HTTP 409. Seed uses
insert-only upserts and never overwrites edits. No reservation or booking is
made by adding a slot. A slot describes capacity, not confirmed transactions.

Database access now validates only MongoDB variables; Phase 1 AI environment
validation is retained. The dashboard does not require Gemini credentials.

Local-only demo access, setup and limitations are described in
[merchant-phase2.md](merchant-phase2.md). Production merchant authentication
is not implemented and demo access is always rejected in production.
