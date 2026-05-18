# COMMERCE LIBRARY

## OVERVIEW

Checkout, Helcim payment integration, cart validation, order storage, webhooks, and training enrollment purchase state live here.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Cart validation | `cart.ts`, `money.ts` | Convert Sanity products into validated CAD line items. |
| Helcim API | `helcim-client.ts`, `helcim-types.ts` | Server-only boundary for invoices, Helcim Pay, and transaction lookup. |
| Checkout secrets | `checkout-secret.ts`, `helcim-hash.ts` | Hash/encrypt tokens before persistence or comparison. |
| Order persistence | `order-store.ts` | Private DB order/payment-event repository and status transitions. |
| Webhooks | `helcim-webhook.ts`, `verified-payment.ts` | Redacted payloads, transaction verification, idempotency. |
| Training purchases | `training-enrollment-store.ts`, `training-payment-email.ts` | Post-payment enrollment scheduling and email handoff. |
| Product email | `product-order-email.ts` | Non-Sanity customer/order email content. |

## CONVENTIONS

- This directory is server-side business logic; keep Helcim tokens and checkout secrets out of client components.
- Amounts are stored as integer cents in the private DB and presented as CAD at boundaries.
- Pending orders are created before returning a Helcim checkout token.
- Persist redacted webhook payloads only; never store raw card or token material.
- Pair behavior changes with the adjacent `*.test.ts` file.

## ANTI-PATTERNS

- Do not store checkout orders, Helcim identifiers, payment events, or customer PII in Sanity.
- Do not trust client cart totals; rebuild totals from loaded sellable products.
- Do not compare raw checkout tokens in storage; use hashes or encrypted values as existing code does.
- Do not make payment emails the source of truth; private DB state is canonical.
