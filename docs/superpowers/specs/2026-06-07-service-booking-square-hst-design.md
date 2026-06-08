# Service Booking Square HST Design

Date: 2026-06-07

## Summary

Service booking payments made through Square Payment Links must collect Ontario HST at 13% on the amount paid today only. Tips remain optional and separate, and are not included in the taxable subtotal. The app should create Square orders that show HST as a real tax, persist the expected non-tip payment total for reconciliation, and keep the existing webhook/return booking finalization flow intact.

## Requirements

- Apply Ontario HST at 13% to the selected service booking payment amount due today.
- For deposits and custom partial payments, tax only the amount paid today.
- For full payments, tax the full selected payment amount due today.
- For add-ons, tax only add-on value included in today’s selected payment amount; add-ons due later are not charged or taxed today.
- Exclude Square tips from tax and remaining-balance calculations.
- Represent HST as tax in Square, not as a fake product line item.
- Reconcile Square payments against the expected non-tip captured amount: base amount paid today plus HST.
- Keep private booking/payment/tax records in PostgreSQL/private DB data structures, not Sanity.

## Recommended Approach

Use a local service booking tax policy that computes a deterministic HST quote, then send that quote to Square as a manual additive line-item tax.

For each booking checkout:

1. Read the existing selected booking payment amount from the hold snapshot.
2. Compute:
   - `taxableAmountCents = amountPaidTodayCents`
   - `taxCents = round(taxableAmountCents * 0.13)`
   - `expectedAmountCents = taxableAmountCents + taxCents`
3. Create a Square Payment Link order with:
   - one booking line item for the pre-tax amount paid today
   - one manual additive tax named `Ontario HST` at `13%`
   - that tax applied to the booking line item
   - `checkout_options.allow_tipping = true`
4. Persist the checkout order expected amount as `expectedAmountCents`, excluding tip.
5. Persist tax breakdown in `checkoutOrders.providerMetadata.tax`; keep line item snapshots pre-tax so existing service payment semantics remain clear:
   - policy version
   - tax name
   - tax rate
   - taxable amount cents
   - tax amount cents
   - expected amount cents

## Data Flow

```text
Booking hold selected payment
  -> service booking tax policy calculates Ontario HST
  -> Square Payment Link order receives line item + applied tax
  -> checkoutOrders.amountCents stores base + HST, excluding tip
  -> Square webhook or return finalizer fetches payment
  -> finalizer compares Square payment.amount_money.amount with checkoutOrders.amountCents
  -> finalizer records Square tip separately and completes booking
```

## Reconciliation Rules

- `checkoutOrders.amountCents` should represent the expected non-tip payment amount: amount paid today plus HST.
- `payment.amount_money.amount` from Square should match `checkoutOrders.amountCents`.
- `payment.tip_money.amount` should be recorded separately as the Square tip amount.
- `payment.total_money.amount` may include tip and must not be used as the primary expected amount comparison.
- If Square reports the old no-tax amount or another mismatch, record the event as an amount/currency mismatch and leave the booking for manual review.
- Existing pending no-tax Payment Links should be allowed to expire or be handled through manual review if paid after the tax deployment.

## Idempotency

Adding tax changes the Square Payment Link request body, so idempotency must include the tax policy version and expected total. This prevents Square from reusing an older no-tax Payment Link for the same hold and base amount.

## Files Likely Affected

- `src/lib/booking/payment-policy.ts` — existing selected amount/cart helpers.
- `src/lib/booking/service-tax-policy.ts` — new cohesive Ontario HST policy boundary.
- `src/lib/booking/square-service-checkout.ts` — Square Payment Link order construction, persisted expected amount, and tax metadata.
- `src/lib/booking/square-client.ts` — Square request typings for taxes/applied taxes.
- `src/lib/booking/square-mock-client.ts` — mock Square totals should include tax.
- `src/lib/booking/square-payment-finalizer.ts` — preserve amount comparison semantics and store any additional tax/tip metadata needed.

## Testing Plan

- Unit test the HST policy:
  - 13% on amount paid today
  - cents rounding
  - tips excluded by design
- Update Square checkout tests:
  - deposit `5000` cents produces `650` cents HST and `5650` expected amount
  - full payment/add-on due-now selected amount is taxed
  - Square order includes line-item tax and tipping remains enabled
  - idempotency key changes when tax policy/expected total changes
- Update Square mock tests so mock payments return `amount_money` equal to base plus HST and `tip_money` separately when applicable.
- Update finalizer tests:
  - accepts Square `amount_money.amount = base + HST`
  - records tip separately
  - rejects no-tax amount as mismatch for new taxed orders
  - duplicate webhook/return behavior remains unchanged

## Operational Notes

- Vercel/Square webhook delivery must be investigated separately: the app route does not emit HTTP 429, so `/api/webhooks/square` should be exempted from Vercel protection/rate-limiting if needed.
- Return reconciliation logging should be improved separately to record safe query-key diagnostics and Square lookup mode, without exposing sensitive data.

## Out of Scope

- Square catalog auto-tax configuration.
- Multi-jurisdiction tax rules.
- Taxing tips.
- Product checkout or training checkout changes.
- Storing private payment/tax details in Sanity.
