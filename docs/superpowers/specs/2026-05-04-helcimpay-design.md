# HelcimPay.js checkout and catalog design

Date: 2026-05-04

## Purpose

Add a custom Lash Her storefront checkout flow that uses Helcim for invoice creation and payment processing through HelcimPay.js. The approved direction is **custom catalog plus Helcim invoices/payments**: the Lash Her site owns the catalog experience and checkout validation, while Helcim owns secure payment processing and invoice/payment records.

This design intentionally does **not** treat Helcim's Invoice API as a product or inventory API. Helcim's invoice documentation states that invoice `lineItems` are independent of products/services stored in the Helcim account and that inventory for invoice line items must be handled in the merchant's own system.

## Architecture boundary

- **Sanity / app catalog layer** owns sellable products, page content, imagery, SEO, merchandising copy, and visible availability.
- **Next.js server layer** validates cart contents, creates Helcim invoices, initializes HelcimPay.js checkout sessions, and stores checkout/session metadata in a private server-side datastore.
- **Helcim** receives immutable invoice line-item snapshots, renders the secure payment iframe, processes payment, and returns payment response data.
- **Post-payment app layer** validates Helcim's response hash, records invoice/payment identifiers, clears cart state, shows confirmation, and triggers any local email or admin notification workflow.

No Helcim API token, per-session `secretToken`, or hash validation logic may be exposed to client code.

## Data flow

The checkout flow is invoice-first, then payment.

1. The user selects a product, course, or service in the Lash Her UI.
2. The client sends cart and customer details to a Next.js server route or server action.
3. The server reloads authoritative catalog data and rejects stale prices, unavailable items, invalid quantities, or tampered totals.
4. The server creates a Helcim invoice with line items containing `sku`, `description`, `quantity`, `price`, tax, discount, and shipping fields as applicable.
5. The server initializes HelcimPay.js with the resulting `invoiceNumber` and stores the returned `secretToken` server-side for validation.
6. The client receives only the `checkoutToken`, loads Helcim's script, and opens the Helcim iframe modal.
7. The client listens for HelcimPay.js `SUCCESS`, `ABORTED`, and `HIDE` messages.
8. On `SUCCESS`, the client sends the payment payload to the server.
9. The server validates the response hash using the stored `secretToken`, persists invoice/payment identifiers, clears cart state, and returns confirmation data.

## Components and modules

Implementation should stay split into small units:

- `helcim-client`: server-only Helcim API wrapper for authenticated requests.
- `catalog` loaders: approved sellable product reads from the chosen catalog source.
- `checkout` route/action: server-side cart validation, Helcim invoice creation, and HelcimPay.js initialization.
- `payment-validation` route/action: HelcimPay.js response hash validation and order status updates.
- Client payment component: loads `https://secure.helcim.app/helcim-pay/services/start.js`, opens/removes the iframe, and forwards payment events to the server.
- Order persistence model/schema: local reconciliation record for invoice, payment, customer, and line-item snapshots stored in a private PostgreSQL database.

## Error handling

- If cart validation fails, return field/item-level errors and do not create a Helcim invoice.
- If Helcim invoice creation fails, do not initialize or open the payment modal.
- If HelcimPay.js returns `ABORTED` or `HIDE`, keep the cart intact so the user can retry.
- If HelcimPay.js returns `SUCCESS` but backend hash validation fails, do not mark the order paid. Show a generic verification failure message and persist/log the event for manual review.
- If payment succeeds but local persistence or email notification fails, preserve enough Helcim identifiers to reconcile the order manually.

## Reconciliation model

Persist a local order/payment record with:

- local checkout/order ID,
- Helcim `invoiceId` and `invoiceNumber`,
- Helcim transaction/payment identifiers from the validated response,
- line-item snapshot used for the invoice,
- customer contact details,
- status: `pending`, `paid`, `verification_failed`, `cancelled`, or `refunded`.

Helcim's Invoice API does not return associated transactions for paid invoices, so transaction lookup, refund, reversal, or deeper reconciliation should use the relevant Payment/Card Transaction API later if needed.

## Testing strategy

Testing must cover the full user and server flow without real card data:

- catalog rendering,
- stale-cart rejection,
- invalid quantity/price tampering rejection,
- Helcim invoice creation payload shape,
- HelcimPay.js initialization payload and token handling,
- iframe `SUCCESS`, `ABORTED`, and `HIDE` message handling,
- hash validation success and failure,
- local order persistence,
- confirmation UI,
- cart clearing after verified payment.

Local HelcimPay.js testing requires HTTPS tunneling because Helcim documents localhost limitations for rendering the payment modal.

## Security requirements

- Store the Helcim `api-token` only in backend environment variables.
- Store each checkout `secretToken` server-side and bind it to the local checkout/order record.
- Never trust client totals, product names, SKUs, prices, taxes, discounts, shipping, or payment status.
- Validate all Helcim success responses server-side before marking an order paid.
- Do not store transaction history or customer PII in public Sanity datasets.
- Keep HelcimPay.js card collection inside Helcim's iframe to maintain reduced PCI scope.

## Open implementation decisions

These are intentionally deferred to implementation planning:

- the exact catalog schema/source for sellable products,
- whether products are physical products, services, training courses, deposits, or a mix,
- tax, discount, shipping, and pickup rules,
- whether customer records should be created or linked in Helcim before payment,
- whether saved payment methods, ACH, Fee Saver, partial payments, or refunds are in scope for the first release.

## Explicit non-goals

- Do not use Helcim Invoice API as a canonical product/inventory API.
- Do not build against undocumented Helcim Product/Inventory endpoints.
- Do not expose Helcim credentials or validation secrets to the browser.
- Do not replace the custom Lash Her site with Helcim Online Checkout in this design.
