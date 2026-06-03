# Service Add-ons Design

Date: 2026-06-03

## Summary

Services will support one optional booking add-on. Add-ons are public service content managed inside each Sanity `service` document. A customer may select no add-on or one add-on during booking. Add-ons increase the displayed booking total and are included in full-payment checkout, but they do not change service duration, appointment availability, or booking slot calculations.

Once a customer starts checkout, the selected add-on and computed payment amount are snapshotted into the private appointment hold. Square checkout will use that private snapshot rather than re-reading Sanity pricing.

## Requirements

- Editors can manage service add-ons in Sanity Studio.
- Each add-on has a required name, required description, optional image, and required price.
- Add-ons are embedded inside each service, not reusable documents.
- Each booking can include zero or one selected add-on.
- Add-ons never affect duration or availability.
- Removing an add-on from a service is how editors stop offering it; there is no per-add-on availability toggle.
- Sanity stores only public/editorial add-on definitions. Private booking selections and payment snapshots remain in PostgreSQL.

## Payment Rules

Given a service with `fullPrice`, `depositAmount`, and an optional selected add-on price:

| Payment option | Amount charged now |
| --- | ---: |
| Pay Deposit | Service `depositAmount` only |
| Pay in Full | Service `fullPrice` plus selected add-on price |
| Pay Custom Amount | Customer-entered amount greater than service `depositAmount` and less than service `fullPrice` |

If an add-on is selected with deposit or custom partial payment, the customer-facing copy must say that the add-on balance is due later.

## Sanity Data Model

Add an `addOns` array to `src/sanity/schemas/documents/service.ts`.

Each item is an embedded object with:

- `_key`, managed by Sanity and used as the selection identifier.
- `name`, required string.
- `description`, required text for public display.
- `image`, optional image with hotspot and optional alt text.
- `price`, required positive number using the same CAD dollar-number convention as existing service prices.

The service schema should validate required fields and reject non-positive prices. Add-on images should not be required.

## Loader and Type Contracts

Extend the existing service projection in `src/data/loaders.ts` so all service reads continue through the current loader path. The projection should include:

- `addOns[]{ _key, name, description, price, image{ asset, hotspot, crop, alt } }`

Extend `src/types/index.ts` with a `TServiceAddOn` type and add `addOns?: TServiceAddOn[]` to `TService`.

## Booking UI Design

Update `src/components/booking/booking-flow.tsx` to track `selectedAddOnKey` for the current service.

The add-on picker appears in the details/payment step before payment options. If a service has no add-ons, the section is omitted. Selecting a different service clears the selected add-on. Selecting a different date or time does not clear it.

The sticky booking summary shows:

- base service name and full price;
- selected add-on name and price, if selected;
- unchanged duration;
- total equal to service full price plus selected add-on price.

Payment option labels reflect the clarified rules:

- deposit label remains the service deposit amount;
- full label includes the selected add-on price;
- custom partial helper text remains based on service deposit/full price only;
- deposit/custom partial with an add-on includes clear “add-on balance due later” copy.

The client sends only `selectedAddOnKey` to `/api/booking/holds`. It must not send add-on name, price, or computed totals.

## Hold API and Snapshot Design

Update `src/app/api/booking/holds/route.ts` to parse optional `selectedAddOnKey`.

The server is authoritative. It loads the published service by slug, validates that the selected key exists on that service, and resolves add-on details from the published Sanity data. Unknown or stale add-on keys return a validation error such as `fieldErrors.selectedAddOnKey`.

The private hold `offeringSnapshot` includes the selected add-on when present:

```ts
selectedAddOn?: {
  key: string;
  name: string;
  description: string;
  price: number;
  currency: "CAD";
}
```

The snapshot also includes `selectedPayment` with the due-now amount and description computed from the payment rules. Once the hold exists, checkout and reconciliation use this private snapshot rather than Sanity.

## Square Checkout Design

Keep the existing one-line-item Square checkout model. `src/lib/booking/square-service-checkout.ts` continues to create a Square payment link from the snapshotted booking payment selection.

For full payment with an add-on, the line item amount is the combined service and add-on amount. For deposit and custom partial payments, the line item amount remains the service-only due-now amount. The line item description should mention the add-on when relevant, but structured add-on data lives in the private hold snapshot.

## Confirmation and Staff Visibility

Confirmation email, internal notes, or appointment details should include the selected add-on name and price when present. They should also state whether the add-on was paid now or remains due later:

- Pay in Full: add-on included in payment.
- Pay Deposit or Pay Custom Amount: add-on balance due later.

## Error Handling

- If a selected add-on key no longer exists, reject hold creation with a clear validation error.
- If add-on pricing is invalid in published Sanity data, reject payment setup as misconfigured rather than silently dropping the add-on.
- Existing slot conflict, hold expiration, and Square checkout errors keep their current behavior.
- Logs should include service slug, add-on key, and failure category, but not customer answers or sensitive contact details.

## Testing Strategy

Add focused tests for:

- Sanity service schema includes embedded add-ons and validates required fields and positive price.
- `SERVICE_PROJECTION` includes add-ons and image metadata.
- Booking flow sends only `selectedAddOnKey` to the hold endpoint.
- Booking summary and payment labels reflect selected add-on pricing rules.
- Hold creation accepts no add-on, valid add-on, and rejects stale/unknown add-on keys.
- Hold snapshots selected add-on and selected payment correctly.
- Full payment with add-on charges `fullPrice + addOn.price`.
- Deposit with add-on charges `depositAmount` only.
- Custom partial with add-on remains bounded by service deposit/full price only.
- Square checkout uses the snapshotted selected payment amount.

Before release, run focused unit tests, booking route tests, booking UI contract tests, relevant Playwright booking coverage, lint, and build.

## Out of Scope

- Multiple add-ons per booking.
- Reusable add-on documents.
- Add-on inventory or availability rules.
- Add-on duration changes.
- Itemized Square line items.
- New private data storage in Sanity.
