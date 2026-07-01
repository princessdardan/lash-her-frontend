# Service Booking Dedicated Payment Page Design

## Summary

Staging currently fails to load the Square card-on-file iframe during service booking with the message `The element #square-card-container was not found`. The payment UI also appears away from the user's current context, forcing scrolling and creating confusion. This design moves payment into a dedicated page at `/services/[slug]/booking/payment`, transfers state through a server-backed opaque payment session, fixes Square iframe initialization, and includes a focused trace for the `/api/booking/availability` `DEP0169` deprecation warning.

## Goals

- Reliably render the Square card-on-file iframe after a service booking hold is created.
- Prevent `card.attach()` from running before the Square container exists in the DOM.
- Replace the current inline payment placement with a focused dedicated payment step.
- Avoid putting raw hold references, Square identifiers, source tokens, payment tokens, or PII in URLs or Sanity.
- Preserve existing card-on-file confirmation and legacy Square hosted checkout fallback behavior.
- Keep `/api/booking/availability` logs clean of app-owned deprecated URL parsing.

## Non-goals

- Changing payment provider selection.
- Storing payment tokens, transaction history, or private booking state in Sanity.
- Re-enabling direct booking creation without secure payment/card-on-file reconciliation.
- Redesigning the entire service booking experience beyond the handoff to payment.

## Approved Approach

Use a dedicated payment page with a private, server-backed payment session:

```text
/services/[slug]/booking/payment?session=<opaque-payment-session-reference>
```

The details page creates a booking hold and receives an opaque session reference. The payment page resolves that reference server-side, validates the service slug and hold state, and renders only safe display data plus the Square payment shell.

This approach was chosen over a popup/modal and over passing the raw hold reference in the URL because it is clearer for customers, more resilient on mobile and refresh, and safer for logs/referrers/history.

## User Flow

1. Customer selects service, date, and time.
2. Customer enters details on the existing booking page.
3. Submit creates a private booking hold through `/api/booking/holds`.
4. The hold creation response includes an opaque payment session reference and expiry information.
5. The client navigates to `/services/[slug]/booking/payment?session=<reference>`.
6. The payment page resolves and validates the session server-side.
7. If valid, the page renders a safe booking summary and Square card-on-file form.
8. Customer accepts the no-show/cancellation authorization and saves a card.
9. The card-on-file confirmation API finalizes the booking state.
10. Success redirects to the existing confirmation destination, such as `/booking/confirmation?payment=booked` or `?payment=manual_followup`.

## Architecture

### Existing Booking Page

`src/app/(site)/services/[slug]/booking/page.tsx` continues to render the service booking intake flow.

`src/components/booking/booking-flow.tsx` should become responsible for:

- service selection when applicable;
- date/time selection;
- customer details and intake answers;
- creating the booking hold;
- navigating to the dedicated payment page.

It should no longer own the Square SDK lifecycle or render the card-on-file form inline.

### Payment Session

A payment session is a short-lived, private DB-backed extension of existing `appointment_holds` state. Add a distinct opaque `paymentSessionReference` for the payment page handoff instead of reusing `appointment_holds.public_reference` in the URL. The reference maps server-side to the existing hold row and safe display information, with a unique index for lookup and the existing hold `expiresAt` remaining the authoritative expiry.

The browser may receive:

- opaque session reference;
- expiry timestamp;
- payment page URL.

The browser must not receive in the URL:

- raw Square source token;
- verification token;
- Square customer/card/order/payment-link IDs;
- internal DB IDs;
- raw payment provider secrets;
- PII beyond what is already entered into the page UI.

### Dedicated Payment Route

Add:

```text
src/app/(site)/services/[slug]/booking/payment/page.tsx
```

The route should be dynamic/no-store because it depends on private, short-lived state.

Responsibilities:

- read `params.slug` and `searchParams.session`;
- resolve the payment session from private DB/server-side services;
- verify session exists;
- verify session belongs to the requested service slug;
- verify the related hold is active and not expired;
- detect already confirmed sessions;
- render active, expired, invalid, or already-confirmed states.

### Payment Client Shell

Create or adapt a client component for the payment page, for example:

```text
src/components/booking/service-booking-payment-shell.tsx
```

Responsibilities:

- display safe booking summary;
- show secure card-on-file copy;
- render `SquareCardOnFileForm`;
- provide back/edit and choose-another-time actions;
- display expired/retry states;
- invoke legacy Square hosted checkout fallback if card-on-file config is unavailable.

### Card-on-file API

The card-on-file confirmation API should accept a payment session reference, or support it alongside the current hold reference during migration. The server should derive the hold and client details from private state instead of relying on raw hold state in the route URL.

The API response must remain safe and must not expose Square customer IDs, card IDs, source tokens, or invoice/payment provider identifiers in UI-visible data.

## Square Iframe Initialization Fix

The current failure happens because `SquareCardOnFileForm` calls:

```ts
card.attach("#square-card-container");
```

while the component is still returning a loading branch that does not include the target container.

The fix is to make the Square container a stable DOM boundary:

- Render the card container before initialization attempts to attach.
- Do not replace the container with the loading UI during config or SDK initialization.
- Show loading/error states around or above the container, not instead of it.
- Prefer a component-owned ref or generated unique container ID over a global static selector.
- Attach only after config is loaded, the Square script is available, and the container DOM node exists.
- Destroy the Square card instance on unmount, session change, config change, or expiration.
- Keep initialization idempotent for React Strict Mode remounts.

## Back, Retry, Expiration, and Fallback Behavior

### Back/Edit

The payment page should offer a clear way to return to details or choose another time. For the first implementation, if no explicit release/cancel path exists, the current hold may expire naturally. If an existing safe release path exists, use it for explicit "choose another time" actions.

### Retry

Card/tokenization failures keep the customer on the payment page with a clear, non-technical error. Retrying must not create a new hold. Network ambiguity or duplicate submits should be protected by server-side idempotency tied to the session/hold.

### Expiration

Client UI should show the expired state and disable confirmation when the session/hold expires. Server APIs remain authoritative and return a conflict for expired or unavailable holds. Expired states should route the user back to choose another time.

### Already Confirmed

If the same session is completed in another tab, the payment page should not render Square again. It should redirect to confirmation or show a safe already-confirmed status.

### Legacy Square Hosted Checkout Fallback

If card-on-file configuration is unavailable, the payment page preserves the existing hosted Square checkout fallback. The fallback should be started through the payment session rather than exposing raw hold data.

## Availability Deprecation Warning

The visible warning is:

```text
[DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications. Use the WHATWG URL API instead.
```

The current availability route already uses `new URL(req.url)` for request parsing. Implementation should still trace the warning source by searching app-owned code and, if needed, running with trace deprecation in a staging-like environment.

Acceptance for this item:

- If app-owned code uses deprecated `url.parse()`, replace it with WHATWG `URL`.
- If the warning originates from Next.js, tests, or a transitive dependency while app code uses `new URL`, document the source and do not make unrelated route changes.
- Preserve existing `/api/booking/availability` behavior and validation.

## Testing Strategy

### Unit and Route Tests

- Payment session creation and lookup.
- Missing/invalid session.
- Session/service slug mismatch.
- Expired session.
- Already-confirmed session.
- Card-on-file confirmation using session reference.
- Safe response shape excluding Square/provider secrets.
- Legacy fallback resolving through session state.
- Availability route behavior unchanged after warning investigation.

### Component and Browser Tests

- Booking details submit creates a hold/session and navigates to `/services/[slug]/booking/payment?session=...`.
- Payment URL does not include raw hold reference, Square source token, or provider identifiers.
- Square `attach()` is only called after the target container exists.
- Payment page renders the iframe area at the active payment step without requiring scroll back to the top of the details form.
- Config unavailable path starts the legacy Square checkout fallback.
- Expired session disables payment and prompts the customer to choose another time.
- Reloading the payment page works because state is server-backed, not sessionStorage-only.

## Acceptance Criteria

- Staging no longer shows `The element #square-card-container was not found` during service booking payment.
- Service booking payment uses `/services/[slug]/booking/payment?session=<opaque-reference>`.
- The card iframe is visible in the dedicated payment step and usable on desktop and mobile.
- No raw Square tokens, Square IDs, payment provider secrets, or raw hold internals appear in the payment URL or UI.
- Successful card save confirms booking through the existing secure card-on-file flow.
- Retry, expired, and config-unavailable paths show clear customer-facing states.
- `/api/booking/availability` has no app-owned deprecated `url.parse()` usage; any external source is documented.
- Relevant unit and focused browser tests pass.

## Risks and Mitigations

- **Session reference leakage:** Use opaque, short-lived references and avoid raw hold/provider IDs.
- **Hold expires during payment:** Show countdown/expired UI and enforce expiry server-side.
- **Duplicate submits or multi-tab completion:** Use session/hold-level idempotency.
- **Strict Mode duplicate Square initialization:** Keep stable container, cancellation guards, and cleanup.
- **Fallback coupling to hold reference:** Move fallback to resolve from payment session.
- **External deprecation warning source:** Trace before changing route code; document if not app-owned.
