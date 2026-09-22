# Square Afterpay

Square is the only active payment provider. Afterpay is a payment method inside Square's Web Payments SDK and Payments API; it does not require separate Afterpay credentials or an additional gateway.

## Canadian eligibility

Square currently documents **C$1–C$2,000 inclusive** for Canadian Afterpay payments and invoices. The limit applies to the final total, including tax, shipping and discounts. C$4,000 is documented for certain US offerings, not Canadian API transactions. Merchant-specific limits and buyer approval can further restrict availability.

Sources checked September 22, 2026:

- [Payments API amount limits](https://developer.squareup.com/docs/payments-api/take-payments#afterpay-minimums-and-maximums)
- [Afterpay Payments API requirements](https://developer.squareup.com/docs/payments-api/take-payments/afterpay-payments)
- [Web Payments SDK eligibility and initialization](https://developer.squareup.com/docs/web-payments/add-afterpay)
- [Invoice BNPL requirements](https://developer.squareup.com/docs/invoices-api/overview)

`src/lib/payments/square/afterpay-policy.ts` is the shared policy and input contract. Do not raise the ceiling based on a generic marketing page or split a purchase to bypass eligibility. If Square changes its Canadian API limits, update this policy, boundary tests and customer copy together.

## Checkout behavior

| Purchase              | Afterpay amount                                                      | Existing requirements                                                                         |
| --------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Products              | Final reserved order total, including shipping/tax                   | Cart, stock, shipping quote and policy checks                                                 |
| Training              | Discounted full program total plus HST                               | Customer details, enrollment terms, paid enrollment and scheduling token                      |
| Services              | Full booked service and add-on total after discounts, plus HST       | Valid hold, policy consent, separate stored card, staff attribution and calendar finalization |
| Future online courses | Reuse the shared UI and payment contract when course checkout exists | Course pricing and paid access must be implemented server-side                                |

`SquareAfterpayButton` builds the CAD payment sheet and attempts `payments.afterpayClearpay` in a `try/catch`. Square's eligibility check controls whether its official button is attached. When unavailable, the checkout explains this and leaves card payment usable. Cancelled or declined tokenization never submits an order. Payment buttons share a synchronous submission lock that stays engaged after success until navigation.

Product/training requests carry `payment.method = "afterpay"`, the payment token and `expectedAmountCents`. The server derives prices independently and requires exact agreement with the sheet before authorization. The authorization's `source_type` must match the selected method. A mismatched authorization is cancelled before capture. Both methods retain the existing order ledger, idempotency, capture reconciliation, refunds and `/api/webhooks/square` signature verification. Historical internal identifiers such as `training_square_card` are retained so reconciliation continues to find those orders.

Services use the existing booking confirmation operation with `paymentMethod = "afterpay"`, `sourceId`, and a separate `cardSourceId`/`cardVerificationToken`. The browser tokenizes that card with `intent: "STORE"`; today's charge uses only the Afterpay token. The server saves the card and no-show policy before capturing the Afterpay authorization. If card storage fails, the authorization is cancelled and the booking is not confirmed. Afterpay does not replace the no-show card or finance subsequent policy charges. Deposits/custom partial payments remain card-only; choose full payment for Afterpay installments.

The public training checkout no longer starts a separate BNPL invoice. Previously issued invoices and their webhook reconciliation remain supported. `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED` controls only the retained invoice creation endpoint, which also enforces the Canadian limit.

## Activation and live verification

No new environment variables or schema migration are required. Product/training still require `SQUARE_COMMERCE_ENABLED=true`; bookings still require `SERVICE_BOOKING_SQUARE_ENABLED=true` and `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true`, with the existing Square credentials and location.

Enable online Afterpay for the intended merchant/location in Square Dashboard and confirm that the merchant categories cover the actual services, training and any future digital courses. Application code cannot enable account eligibility. Production SDK initialization performs the seller/transaction check; Sandbox ignores seller eligibility and cannot certify production availability.

Before deploying to production, verify the SDK sheet with the intended Square Sandbox application/location, then confirm live account eligibility. Check eligible and over-limit totals, HST/shipping/promotions, cancellation, decline, duplicate submission, service card-storage failure, paid order/appointment state and webhook recovery. Follow the existing launch smoke matrix for live PostgreSQL and fulfillment behavior. Do not place a real charge merely to test without authorization.

Square documents refunds for Afterpay up to 120 days from purchase. Keep the existing refund API and provider-error handling; do not promise a longer refund window for this method.

## Automated verification

Run `npm run test:bnpl` for browser checks of the actual React checkout components using mocked SDK and API boundaries. The suite needs Chromium but no database, dev server or Square credentials. The fixture is outside the application route tree.

Source tests cover amount boundaries, tax/shipping-inclusive totals, stale prices, malformed methods, provider source-type mismatches, cancellation on ledger/card-storage failure, service policy-card separation, staff attribution and commerce webhook recovery. These tests prove application behavior with fakes; they do not prove live merchant approval or live database reconciliation.

## Future course checkout

Reuse `SquareAfterpayButton`, `SquareCheckoutPayment`, `validateSquareAfterpayPayment` and `authorizeCaptureSquarePayment`. Create the course order from trusted course pricing, bind an idempotency key, and grant access only through the course's verified payment finalizer/reconciliation. Preserve `BUY_NOW_PAY_LATER` provider evidence and the Square provider identity. The course catalog, enrollment/access model and delivery routes are not implemented by this change.
