# Service Booking Payment and Charge-and-Store Design

## Summary

The service booking funnel should split service selection from customer/payment completion. `/services/[slug]/booking` should collect only service-related choices: appointment time, optional add-ons, and existing intake questions. `/services/[slug]/booking/payment` should collect customer details, payment amount, policy consent, and Square card details in one focused payment step.

The payment step must use Square's Web Payments SDK charge-and-store flow so the customer enters card details once. A booking is confirmed only after all required business conditions are satisfied: the customer has accepted the booking/no-show/card-storage policy before payment capture begins, the required payment/deposit has been captured, the card has been saved for no-show protection, and booking finalization has completed or reached an explicitly accepted manual-follow-up state.

## Goals

- Remove name, email, phone, marketing opt-in, and payment amount selection from `/services/[slug]/booking`.
- Keep existing service intake questions on `/services/[slug]/booking` because they are service-related details.
- Create a provisional private appointment hold from service/time/add-on/intake selections before the payment page.
- Move customer details, payment/deposit amount, no-show/card-storage consent, and Square card entry to `/services/[slug]/booking/payment`.
- Fix Square tokenization by providing a valid `verificationDetails.billingContact` object.
- Support Canadian postal-code validation through Square card-field behavior and Canadian billing context.
- Replace misleading “No payment is taken today” copy with accurate charge-and-store language.
- Ensure no PII, raw payment tokens, card data, provider secrets, or private payment records are stored in Sanity.

## Non-goals

- Changing service catalog pricing/content in Sanity.
- Storing raw card numbers, CVV, Square source tokens, verification tokens, or live payment submissions in Sanity.
- Re-enabling direct booking confirmation without secure payment and card-on-file reconciliation.
- Replacing Square as the service booking provider.
- Redesigning unrelated product/training checkout flows.

## Approved User Flow

1. Customer opens `/services/[slug]/booking`.
2. Customer selects appointment time.
3. Customer chooses optional add-on, if available.
4. Customer answers existing service intake questions, if required.
5. Submit creates a provisional appointment hold with an opaque payment session reference.
6. Browser navigates to `/services/[slug]/booking/payment?session=<opaque-reference>`.
7. Payment page resolves the session server-side and displays service/time/add-on/pricing summary.
8. Customer enters name, email, phone, payment amount choice, and optional marketing opt-in if retained.
9. Customer checks one consent box authorizing both today’s payment and saved-card/no-show policy terms.
10. Customer enters Square card details once.
11. Client tokenizes with Square `CHARGE_AND_STORE` and submits the token plus customer/payment/consent data to the booking payment API.
12. Server validates and persists policy evidence before payment capture, then completes Square payment/card storage and booking finalization.
13. Success redirects to booking confirmation only after the booking success conditions are met.

## Route Responsibilities

### `/services/[slug]/booking`

This route is the service-selection/reservation step.

It collects:

- appointment date/time;
- optional add-on;
- existing intake questions.

It must not collect:

- full name;
- email address;
- phone number;
- marketing opt-in;
- payment/deposit amount;
- no-show or card-storage consent;
- Square card details.

Submitting this page calls the hold API with only service-related data and receives a payment page URL.

### `/services/[slug]/booking/payment`

This route is the customer and payment completion step.

It collects:

- full name;
- email address;
- phone number;
- payment/deposit amount selection;
- marketing opt-in if the business still wants it in the service booking flow;
- one booking/no-show/card-storage consent checkbox;
- Square card details.

It displays:

- selected service;
- selected add-on;
- selected appointment time;
- amount due today;
- no-show/card-storage policy summary;
- hold/session expiration state.

## Data Flow and State Model

### Provisional Hold Creation

The hold API should create a private `appointment_holds` row from:

- service slug / offering id;
- selected start/end time;
- selected add-on snapshot;
- service intake answers;
- immutable pricing bounds such as deposit amount, full price, currency, add-on price, and permitted custom amount range.

The hold should not yet contain real customer contact details or selected payment amount. If the current database schema requires `customerSnapshot`, use an explicit pending placeholder and mark the hold metadata as customer/payment pending. Downstream finalization must reject any hold that still has pending/blank customer or payment details.

### Payment Session Resolution

The payment page should resolve the opaque payment session server-side. The session display data should include:

- service slug/title;
- selected start/end/timezone;
- selected add-on;
- pricing bounds and currency;
- hold expiration timestamp;
- safe display summary.

The resolver must not require a previously selected payment amount because payment amount selection now happens on the payment page.

### Payment Completion

The charge-and-store API should accept:

- payment session reference;
- validated contact details;
- selected payment option and custom amount, if applicable;
- policy acceptance flag/version/hash evidence;
- Square source token and verification token;
- idempotency key.

The server must recompute and validate amount due from the hold’s immutable pricing snapshot. Client-supplied amount is only a request/selection, never a source of truth.

## Square Charge-and-Store Requirements

The client should tokenize once with Square Web Payments SDK using `verificationDetails` shaped for a Canadian charge-and-store booking:

```ts
{
  amount: "<server-rendered amount due today>",
  currencyCode: "CAD",
  intent: "CHARGE_AND_STORE",
  customerInitiated: true,
  sellerKeyedIn: false,
  billingContact: {
    givenName: "...",
    familyName: "...",
    email: "...",
    phone: "...",
    countryCode: "CA"
  }
}
```

If a postal code is collected or made available by Square card fields, Canadian postal codes must be accepted. The UI should refer to the field as postal code rather than ZIP-only language. Square documentation states the embedded card form adapts postal-code labels and validation to the card issuing country; passing Canadian billing context prevents a US-only assumption.

## Consent and Payment Ordering

The customer must check the booking/no-show/card-storage policy box before payment starts. If unchecked, no tokenization, Square payment, card storage, or booking finalization should occur.

The server-side order is:

1. Lock/claim the hold with idempotency.
2. Validate hold is active and belongs to the requested service/session.
3. Validate customer details and selected payment option.
4. Validate consent is present and policy version/hash matches the UI.
5. Persist policy acceptance evidence in private DB before payment capture begins.
6. Create/reuse Square customer.
7. Authorize payment for amount due today, using delayed capture if Square supports this cleanly for the flow.
8. Save card-on-file from the Square payment/card flow.
9. Capture payment after card storage succeeds.
10. Persist safe payment/card metadata, selected payment details, no-show charge record, and hold links.
11. Finalize calendar booking.
12. Return safe confirmation response.

If Square’s exact charge-and-store API path requires immediate capture before card storage can be completed, the implementation must explicitly handle captured-payment/card-save failure as a non-confirmed recovery state, such as refund-required/manual-follow-up, and alert staff. The preferred design is authorization first, card storage second, capture third.

## Booking Success Conditions

A booking may be shown as confirmed only when all are true:

- policy/card-storage consent evidence has been recorded;
- required payment/deposit has been captured;
- card-on-file has been saved for no-show protection;
- selected appointment has been finalized in the booking/calendar system, or a deliberately supported manual-follow-up state has been reached.

If any required condition is missing, the customer must not see a normal confirmed-booking success state.

## Customer-Facing Copy

Remove all copy that says no payment is taken today.

Recommended heading and copy direction:

- Heading: `Pay and confirm your booking`
- Intro: `Today’s payment secures your appointment. Your card will also be stored for no-show and late-cancellation protection according to the booking policy.`
- Checkbox: `I authorize Lash Her to charge today’s booking payment and store my card for no-show or late-cancellation protection according to the booking policy.`
- Button: `Pay and confirm booking`

Copy must stay consistent across the page header, card form, checkbox, summary, and submit button.

## Failure and Recovery States

- **Validation failure:** show field-level errors; do not call Square.
- **Consent missing:** block submission before tokenization/payment.
- **Expired hold:** disable payment and prompt the customer to choose another time.
- **Payment declined/authorization failed:** do not save card or confirm booking; allow retry while hold is active.
- **Card storage fails before capture:** cancel/void authorization where supported; do not confirm booking.
- **Capture fails after card storage:** keep recoverable state, retry/cancel according to provider capability, and do not confirm until capture succeeds.
- **Payment captured but card storage/finalization fails:** mark refund-required/manual-follow-up, alert staff, and avoid normal confirmation copy.
- **Duplicate submit:** use hold-scoped idempotency and return existing terminal/in-progress state without duplicate payment, card, or calendar booking.

## Testing Strategy

### Unit and Route Tests

- Hold creation accepts service/time/add-on/intake answers without contact/payment fields.
- Hold creation rejects invalid service time, invalid add-on, and missing required intake answers.
- Booking page source no longer renders name/email/phone/payment amount fields.
- Payment session resolves provisional holds without selected payment amount.
- Payment session rejects expired, mismatched, booked, or unavailable holds.
- Charge-and-store API rejects missing contact details, invalid payment selection, unchecked consent, and expired holds before Square calls.
- Server recomputes amount due from hold snapshot and rejects client mismatch.
- Policy evidence is persisted before Square payment/capture calls.
- Successful orchestration creates/reuses Square customer, records payment, saves card, persists policy/no-show records, and finalizes booking.
- Failure states do not produce normal booking confirmation.

### Component and Browser Tests

- `/services/[slug]/booking` shows time, add-ons, and intake questions only.
- `/services/[slug]/booking/payment` shows contact fields, payment amount selector, policy checkbox, and Square card entry.
- Payment copy contains no `No payment is taken today` language.
- Square tokenization receives `CHARGE_AND_STORE`, `currencyCode: "CAD"`, and `billingContact.countryCode: "CA"`.
- Canadian postal-code-capable card entry is not constrained to US ZIP wording.
- Successful payment redirects to confirmation.
- Declined/failed payment stays on the payment page with retry messaging.

## Acceptance Criteria

- Booking page collects only service-related details: appointment time, optional add-ons, and existing intake questions.
- Payment page collects contact details, payment amount, policy consent, and Square card details once.
- The customer must consent before payment/card storage begins.
- The Square error `verificationDetails.billingContact is required and must be a(n) object.` no longer occurs for valid submissions.
- Canadian postal codes are accepted by the payment field experience.
- The UI accurately states that today’s payment is charged to finalize the booking and the card is stored for no-show protection.
- A booking is confirmed only after consent, captured payment, saved card, and booking finalization requirements are met.
- No raw card data, Square source tokens, verification tokens, provider secrets, or private payment records are stored in Sanity or exposed in URLs/UI.

## Risks and Mitigations

- **Hold expires while completing payment:** show expiry state/countdown and consider increasing hold TTL if completion rates drop.
- **Placeholder customer data reaches finalization:** require captured customer/payment status before any calendar/email finalization.
- **Square API does not support the preferred delayed-capture sequence for this exact flow:** implement explicit captured-but-card-save-failed recovery with alerts/refund-required state.
- **Duplicate submissions:** use hold/session-level idempotency and progress checkpoints.
- **Pricing drift:** use immutable hold snapshots and server recomputation rather than current Sanity values at payment time.
- **Policy evidence without payment from abandoned attempts:** keep evidence attached to the hold/attempt and expire according to private-data retention rules.
