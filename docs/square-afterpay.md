# Square Afterpay

Square is the active provider. Products, services and training use the Web Payments SDK and Payments API. **Every Afterpay payment is limited to C$1–C$2,000, subject to merchant eligibility and buyer approval.** No checkout promises full Afterpay financing above C$2,000. Training invoices use the same ceiling.

## Checkout behavior

| Purchase                  | Afterpay amount                                                            | Other requirements                                                     |
| ------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Products                  | Entire final total, including discounts, tax and shipping; maximum C$2,000 | Existing stock, shipping and policy checks                             |
| Services                  | Entire service/add-on total after discounts and HST; maximum C$2,000       | Separate stored policy card; partial/deposit payments remain card-only |
| Training, Afterpay only   | Entire discounted total including HST; maximum C$2,000                     | Customer details and enrollment terms                                  |
| Training, Afterpay + card | Customer-selected portion from C$1 to C$2,000                              | Remaining balance paid by card today; minimum card portion C$1         |

For example, a C$3,500 training program totals C$3,955 after Ontario HST. A customer may request **C$2,000 through Afterpay and pay C$1,955 by card today**. The buyer can select a smaller Afterpay portion. Afterpay may collect its first installment today. Approval and available spend remain Afterpay's decision.

`SquareAfterpayButton` checks eligibility through Square before displaying its button. The amount sent to the SDK is exactly the amount requested from Afterpay, including the allocated share of tax. The server recalculates the full training quote and validates both the full displayed total and the selected portion before any payment authorization. There is no second Afterpay loan.

## Training split payment lifecycle

1. Both payment sources are tokenized in the browser. Card verification uses only the card remainder. No server charge starts if either tokenization fails or is cancelled.
2. Reserve one private training order and enrollment with the trusted full total. Persist the chosen portions and a deterministic reservation key. Reusing that key with a different program, amount or payment flow is rejected.
3. Create one Square Order. Authorize the card remainder first, then the Afterpay portion, using separate deterministic payment keys and `autocomplete: false`. Afterpay authorization can start the installment plan and collect its first installment.
4. Capture both authorized payments using Square `PayOrder`, verifying the completed order includes both expected tenders. If individual payment records remain approved, complete those same payment IDs explicitly. Persist that step so a retry can finish the remaining payment. Verify both payment IDs, amounts, currency, order/reference and source types through Square. Mark the enrollment paid only when both payments are `COMPLETED`.
5. Send the existing scheduling notifications. Signed payment webhooks, the payment reconciliation cron, and `/api/training-checkout/split-status` recover interrupted requests using stored payment IDs, without new tokens or authorizations.

A transaction-scoped PostgreSQL advisory lock serializes each split attempt and works through transaction poolers. Payment-state writes commit independently of the lock transaction so they survive interrupted requests. This operation uses two pool connections. The order's JSON provider metadata stores `flow: training_square_split` and `splitPayment` containing portions, provider IDs and stage. No new table or migration is needed; payment tokens are never persisted.

Declines cancel both authorizations, including unknown outcomes by idempotency key. A new checkout attempt is permitted only after both cancellations are confirmed. An uncertain capture retains the original attempt and shows **Check payment status**. The browser stores the opaque reservation key and checkout email in session storage to recover after reload; it removes them after confirmed payment or cancellation. Unknown or missing reservations require review before another payment.

### Operational recovery

The existing authenticated `/api/admin/payment-reconciliation` job also reconciles pending split attempts older than one minute, up to 20 per run. Keep that scheduled job and the shared `/api/webhooks/square` payment subscriptions active.

If one payment is completed and the other is not, the app leaves enrollment pending, blocks a new attempt, and logs `split_payment_requires_review` with the local order reference. Review **both** payment IDs in `providerMetadata.splitPayment` and the Square order before taking action. If completion cannot be recovered, cancel any remaining authorization and refund the captured portion through Square according to the purchase terms. Do not mark the order paid from one receipt, or use `providerPaymentId` alone to calculate a full-order refund: that field is the Afterpay payment ID; the card payment is stored separately. Manual resolution must reconcile the private order state before allowing a new payment. No automatic partial-capture refund is issued.

## Invoice compatibility

The public training checkout uses embedded Afterpay and Afterpay + card. It does not redirect to invoices. The existing `/api/training-checkout/square-invoice` endpoint remains gated by `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED` and rejects totals above C$2,000. Existing invoice webhooks and card fallback remain supported. See [the invoice runbook](training-afterpay-square-invoice.md).

## Configuration and verification

Embedded products/training require `SQUARE_COMMERCE_ENABLED=true` and existing Square credentials. Services retain their existing Square and card-on-file flags. Split checkout also uses the Orders API (`ORDERS_WRITE` for OAuth credentials) as well as payment permissions. Enable Afterpay for the intended Square merchant/location; the SDK performs the eligibility check. There are no new environment variables.

Run `npm run test:bnpl` for actual React checkout components with mocked SDK/API boundaries. Unit tests cover quote validation, strict portion limits, authorization ordering, cancellations, unknown outcomes, partial captures, replay recovery and invoice rejection above C$2,000. A Square Sandbox integration check on 2026-09-23 also exercised the application payment coordinator with a C$3,955 order: C$2,000 Afterpay and C$1,955 card. Both tenders reached `COMPLETED`; retry recovery kept the payment count at two. Test-payment refunds were submitted. A separate Sandbox decline test confirmed that an Afterpay rejection cancels the card authorization and permits a fresh attempt only after cancellation. Sandbox returned a completed order from `PayOrder` while both payment records remained approved; explicit completion of those same IDs succeeded. The coordinator handles that state without granting enrollment early.

The configured `TEST_DATABASE_URL` rejected authentication, so the added database test for reservation binding, advisory locking and durable receipt replay could not run to completion. Resolve those test credentials and run the database suite before release. Sandbox results do not establish production merchant eligibility; confirm that separately. No live charge was placed.

## Sources

- [Square Afterpay Payments API requirements](https://developer.squareup.com/docs/payments-api/take-payments/afterpay-payments)
- [Square Canadian amount limits](https://developer.squareup.com/docs/payments-api/take-payments#afterpay-minimums-and-maximums)
- [Pay for an order using multiple payments](https://developer.squareup.com/docs/orders-api/pay-for-orders)
- [PayOrder reference and idempotency](https://developer.squareup.com/reference/square/orders-api/pay-order)
- [Afterpay merchant vs customer limits](https://www.afterpay.com/en-NZ/business/resources/education-hub/afterpay-merchants-vs-customer-limits) describes combining Afterpay with another payment method; this is a New Zealand resource, not a Canadian Square integration guarantee.
