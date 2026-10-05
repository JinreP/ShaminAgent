# Buyer → Merchant demo integration

Buyer now obtains full parts/repair packages through the official A2A SDK and
uses the official MCP SDK for explicit approval, parts reservation, booking and
simulated payment. No Buyer prices or orders are invented locally. Historical
demo receipts remain readable; old unsigned/unlinked offers require fresh quotes.

## Local setup

After pulling this branch, stop the dev server and run:

```sh
npm ci
npm run buyer:merchant:setup
npm run merchant:demo:seed -- --check
```

The setup script adds missing local settings and generates separate server-only
service secrets in the ignored `.env.local`. It preserves MongoDB, Gemini and
existing access keys, rejects conflicting configuration before writing, prints no
secret and makes no external requests. A2A and MCP share one configured service
Buyer identity; browser ownership is still enforced separately on repairRequests.

If the demo merchant fixtures have not been seeded in your intended demo DB,
initialize them with `npm run merchant:demo:seed`. This creates five simulated
merchants and preserves existing edits. The seed writes to the configured DB;
the `--check` command above is read-only.

Start `npm run dev` and open the exact configured origin, normally
`http://localhost:3000`. Avoid mixing localhost/127.0.0.1 or switching ports.

Demo report fields:

- Vehicle: `Toyota Prius 30`
- Parts: `Урд бампер, зүүн урд гэрэл`
- Tasks: `Солих, бампер будах`
- Budget: `1500000` or higher, in whole MNT
- Deadline: `10` days for the October 5 demo, or enough days to cover a saved slot

The existing merchant seed has slots on October 12–14, 2026. A 2–3 day deadline
on October 5 therefore returns no eligible repair quote. Edit slots through the
Merchant dashboard if you want nearer dates; Buyer does not manufacture slots.

## Negotiation

The combined target is allocated proportionally between the parts and repair
offers, in whole MNT. Each merchant independently accepts, counters or rejects.
Buyer stores both immutable requests/IDs before sending them and reuses them on
retry. Pending human decisions remain pending after refresh. The button then
checks `get_negotiation_result` instead of initiating another round. Other bundles
sharing superseded revisions are disabled and require fresh RFQs.

Seed settings require human approval and do not enable automatic negotiation by
default. For an automatic local demo, in each relevant Merchant dashboard's
**Хувийн үнийн тохиргоо**, enable **Үнэ тохиролцох боломжтой** and
**Автомат хэлэлцээ зөвшөөрөх**, disable **Хүний зөвшөөрөл шаардах**, then save.
For human negotiation, leave human approval enabled and run the configured
Telegram worker. Buyer never silently falls back to fake discounts.

## Checkout

1. Select a complete package and review prices, Merchant terms and exact slot.
2. Check consent and click Confirm. MCP checks availability and returns a link.
3. Open the Merchant approval page and click **Зөвшөөрөх** yourself.
4. Return to Buyer and click **Зөвшөөрөл шалгаад захиалга үргэлжлүүлэх**.
5. Buyer creates the parts order, books repair, records a successful **mock**
   payment, validates transaction status and saves the returned IDs as a receipt.
6. Refresh and reopen the saved request. Checkout uses the same transaction ID;
   completed requests return the same receipt, never an extra order.

The approval page does not require a Merchant dashboard login. It is deliberately
loopback/demo-only and disabled in production. Production identity/approval
integration is a separate task. The adapter refuses production commerce rather
than relabelling this demo as a deployed purchasing system.

Order → booking → mock payment is a resumable sequence with Merchant compensation,
not a single atomic transaction. Failures/recovery states are surfaced. If the
approval response is lost before Buyer saves the link, Buyer does not repeat the
non-idempotent approval tool; create a new request and let the old intent expire.
New parts/booking writes require verified approval; checking the Buyer checkbox
does not verify the Merchant approval.

## Validation

```sh
npm run typecheck
npm run lint
npm run build
npm test
npm run test:buyer:merchant
```

The Buyer integration test creates its own disposable MongoDB replica set. It
does not load `.env.local`, use Atlas, send Telegram messages, call Gemini or
charge money. A2A and MCP exchanges use the actual SDKs and Merchant handlers,
with injected in-process HTTP transport. User approval is explicitly simulated
only inside the test.
