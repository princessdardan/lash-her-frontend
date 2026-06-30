# Booking System Architecture Reference

Date: 2026-05-23

This document is the durable reference for the current Lash Her booking architecture. It records the provider boundaries, lifecycle state, and operational invariants that should stay true as the system evolves.

## Executive Decision

All booking-related flows use app-owned private eligibility and private operational state, but payment and scheduling providers are split by product surface.

Service bookings keep the custom Lash Her slot-selection UI. The app creates private Postgres holds, collects explicit no-show/cancellation policy acceptance, tokenizes and stores a Square card on file behind a feature flag, creates a draft no-show charge instrument, and finalizes verified bookings through the Google Calendar API. When the card-on-file feature is disabled or unavailable, the app falls back to the legacy Square hosted checkout (Payment Link) flow and treats Square browser return as a reconciliation hint only. Product checkout and training checkout remain Helcim-backed by default and must not require Square environment variables unless the optional training Afterpay Square Invoice flow is enabled. When `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`, training checkout can create and publish a Square invoice instead of using Helcim; see `docs/training-afterpay-square-invoice.md` for the launch gate, webhook routing, and recovery rules. Paid training intro-call scheduling uses a private app token gate first, then shows a public Google Appointment Schedule link or embed. The app does not mark training as scheduled only because that page renders.

## Decision Record

| Decision                                                                   | Status      | Reason                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep custom slot picker for service bookings                               | Locked      | Lash appointments require availability before payment, 10-minute holds, and Square payment before final Calendar booking.                                                                                         |
| Use Square for service booking payments                                    | Locked      | Service booking stores a Square card on file (or falls back to hosted checkout) from a private hold. Square is not the product or default training checkout provider.                                             |
| Keep Helcim as the default provider for product and training checkout      | Locked      | Product orders and paid training enrollment checkout use the existing Helcim commerce flow unless the optional training Afterpay Square Invoice feature is explicitly enabled.                                    |
| Allow optional training Afterpay Square Invoice checkout                   | Locked      | When `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`, training checkout may create a Square invoice for Afterpay/Clearpay. This is an exception, not the default; see `docs/training-afterpay-square-invoice.md`. |
| Use Google Appointment Schedule only after paid training token eligibility | Locked      | Appointment Schedules support public link/embed. The app must gate the URL through private paid token eligibility and must not use Appointment Schedule for service bookings.                                     |
| Keep Google Calendar as final calendar                                     | Locked      | Nataliea's operational calendar remains the staff source of truth.                                                                                                                                                |
| Keep Sanity editorial/config only                                          | Locked      | Sanity must not store PII, payment state, holds, or booking history.                                                                                                                                              |
| Store lifecycle state in private Postgres                                  | Locked      | Holds, payment state, booking state, failures, and reconciliation need durable private audit records.                                                                                                             |
| Use a shared idempotent finalizer                                          | Locked      | Browser validation and webhooks can both report payment success.                                                                                                                                                  |
| Use Redis only for short race locks                                        | Recommended | Redis TTL is useful for contention, but private DB must remain canonical.                                                                                                                                         |
| Adopt Vercel Workflow                                                      | Optional    | Useful for durable sleeps/hooks/retries, but minimal v1 can use route handlers, private DB, and cron/reconciliation.                                                                                              |

## External Platform Findings

Google Calendar supports:

- Sharing or embedding Appointment Schedule booking pages.
- Multiple booking pages on eligible plans.
- Appointment Schedule payments through Stripe only.
- Calendar API `freeBusy.query` for busy intervals.
- Calendar API `events.insert`, `events.update`, and `events.delete` for normal events.
- Calendar event watches for event changes.

Google Calendar does not expose documented Appointment Schedule APIs for service booking needs:

- creating temporary booking-page holds,
- booking an Appointment Schedule slot programmatically,
- collecting Square or Helcim payments inside the Google booking page,
- returning Google's precomputed booking-page slots,
- arbitrary customer-info prefill in the embed.

Implication: paid Lash Her service booking must be a custom app flow that uses Google Calendar as a calendar backend, not as the customer-facing scheduling engine. Paid training intro-call scheduling is different: after private token eligibility passes, the customer can use a public Google Appointment Schedule link or embed.

## System Boundaries

| System                      | Responsibility                                                                                                                                                                           | Must Not Do                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Sanity                      | Public/editorial bookable service config, native payment fields, copy                                                                                                                    | Store PII, holds, payment status, booking history, transaction data                                                   |
| Private Postgres            | Holds, orders, payment events, booking lifecycle, training eligibility, audit/reconciliation                                                                                             | Act as public CMS                                                                                                     |
| Redis / Upstash             | Google OAuth token storage and short-lived race locks                                                                                                                                    | Be canonical booking/payment state                                                                                    |
| Google Calendar API         | Service booking busy-time source and final staff event store                                                                                                                             | Gate payment or hold Appointment Schedule slots                                                                       |
| Google Appointment Schedule | Paid training intro-call scheduling after private token eligibility                                                                                                                      | Verify paid status, gate the schedule URL, or book service appointments                                               |
| Square                      | Service booking card-on-file storage, hosted checkout fallback, payment event source, and (when `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`) training Afterpay Square Invoice source | Act as a global checkout provider for products or as the default training checkout provider                           |
| Helcim                      | Default product checkout and training checkout payment event source                                                                                                                      | Process new service booking payments or process training checkout when the optional Square invoice feature is enabled |
| Resend                      | Transactional customer/admin emails                                                                                                                                                      | Be the source of truth for booking state                                                                              |

## Canonical Flow: Paid Service Booking

```text
Offering selected
  -> availability requested
  -> Google busy intervals loaded
  -> active private holds loaded
  -> slots displayed
  -> slot selected
  -> server revalidates slot
  -> private 10-minute hold created with selected payment snapshot
  -> customer accepts no-show/cancellation policy
  -> Square Web Payments SDK tokenizes card with STORE intent
  -> server creates or reuses a Square customer
  -> server saves the card on file through the Square Cards API
  -> private DB stores card references + policy acceptance
  -> draft Square no-show invoice/order or equivalent charge record created
  -> Google Calendar API event created or found idempotently
  -> hold marked booked with private DB state updated
  -> customer/admin emails sent
```

The card-on-file flow requires explicit policy acceptance before the card token is submitted. The app never stores raw card tokens, full PANs, or Square webhook bodies in Postgres; it persists only Square customer/card references, last-4/brand/expiry metadata, policy acceptance hashes, and no-show charge record state.

The legacy Square hosted Payment Link flow remains available as a fallback when `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED` is not `true` or when the card-on-file configuration is unavailable. In the legacy fallback, the browser redirects to Square hosted checkout, Square return is not proof of payment, and the server reconciles the Square payment through webhook/return handling before finalizing the Calendar event.

Duplicate card-save submissions, return visits, and webhook events must resolve to one saved card, one policy acceptance, one no-show charge record, and one Google Calendar event.

## Canonical Flow: Paid Training Intro Call

Default path (Helcim):

```text
Training checkout completed
  -> Helcim payment verified
  -> training enrollment/order marked paid in private DB
  -> private app schedule token issued
  -> customer opens paid training schedule page
  -> token eligibility resolved from private paid state
  -> Google Appointment Schedule link or embed rendered
  -> Google owns the Appointment Schedule booking after handoff
```

Optional Square Afterpay Invoice path (when `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`):

```text
Training checkout completed
  -> Square invoice created and published for the training order
  -> Square webhook invoice.payment_made verified
  -> training enrollment/order marked paid in private DB
  -> private app schedule token issued
  -> customer opens paid training schedule page
  -> token eligibility resolved from private paid state
  -> Google Appointment Schedule link or embed rendered
```

The app does not mark training as scheduled just because the schedule page renders. Invalid, unpaid, expired, or wrong-program tokens must not reveal the Appointment Schedule URL. See `docs/training-afterpay-square-invoice.md` for the feature flag, webhook routing, launch gate, and recovery rules.

## Hold And Booking State Model

Recommended hold states:

| State                               | Meaning                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `held`                              | Slot is temporarily reserved before payment.                                                                            |
| `payment_pending`                   | Hold is associated with an initialized Square checkout.                                                                 |
| `paid_pending_booking`              | Square payment is verified, Calendar event has not completed yet.                                                       |
| `paid_unbookable_rebooking_pending` | Square payment is verified, but the original service slot is expired or unavailable and staff must try rebooking first. |
| `booked`                            | Google Calendar event exists and booking is confirmed.                                                                  |
| `expired`                           | Hold expired before successful payment/finalization.                                                                    |
| `payment_failed`                    | Payment attempt failed or verification failed.                                                                          |
| `booking_failed`                    | Payment succeeded but Calendar booking failed.                                                                          |
| `manual_followup`                   | Staff action is required, usually after paid booking failure or race.                                                   |
| `released`                          | Customer intentionally abandoned/restarted the hold before payment.                                                     |

Required stored fields:

- hold ID and public-safe hold reference,
- offering ID, offering snapshot, and immutable selected payment snapshot,
- customer contact snapshot,
- selected start/end/timezone,
- `expires_at`,
- checkout provider and provider order/payment references,
- Google Calendar event ID,
- failure reason/reconciliation metadata,
- timestamps.

## Finalizer Requirements

The finalizer is the only code path that confirms paid booking flows.

It must:

- accept verified Square service booking payment state from browser return reconciliation and Square webhooks,
- lock the relevant order/hold rows,
- verify payment amount, currency, approval, provider order identity, and transaction ID before Calendar finalization,
- verify the hold is still valid or within the explicitly accepted payment-success grace policy,
- search for an existing Calendar event by stored ID or deterministic metadata before creating a new event,
- create the final Google Calendar event through `events.insert`,
- store `google_event_id`,
- mark the hold `booked`,
- send emails non-blockingly,
- return the already-confirmed result on duplicate calls.

## Failure Policies

| Failure                                         | Policy                                                                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two customers select the same slot              | Server revalidation plus DB conflict prevention decides winner.                                                                                                                               |
| Hold expires before payment                     | Checkout cannot finalize automatically unless the payment success arrives inside the defined grace policy; `payment_pending` holds continue blocking the slot during that grace window.       |
| Payment succeeds after slot becomes unavailable | Mark `paid_unbookable_rebooking_pending`; manually rebook first, verify the replacement slot before creating a Calendar event, and refund only after rebooking fails or staff chooses refund. |
| Browser closes after payment                    | Square webhook can still reconcile payment and run finalization.                                                                                                                              |
| Client validation and webhook both arrive       | Finalizer is idempotent and creates one Calendar event.                                                                                                                                       |
| Calendar insert succeeds but response is lost   | Retry searches deterministic metadata before inserting again.                                                                                                                                 |
| Calendar insert fails after payment             | Mark `booking_failed` or `manual_followup`; alert/admin surface it.                                                                                                                           |
| Email fails                                     | Booking remains confirmed; failure is logged/reported.                                                                                                                                        |

## Current Route And Module Shape

Keep these route and module boundaries aligned with the implementation:

- `GET /api/booking/availability`: offering-aware slot availability.
- `POST /api/booking/holds`: create a 10-minute hold after server revalidation.
- `GET /api/booking/square/config`: public-safe Square Web Payments SDK config when card-on-file is enabled.
- `POST /api/booking/card-on-file`: confirm a service booking by saving a Square card on file, recording policy acceptance, and finalizing the Calendar event.
- `POST /api/booking/checkout`: initialize legacy Square hosted checkout for service booking holds when card-on-file is disabled.
- `GET /api/booking/square/return`: reconcile Square return hints server-side before redirecting to booking confirmation.
- `POST /api/webhooks/square`: verify Square webhook signatures, dedupe events, and route service-booking payment/no-show reconciliation and training invoice `invoice.payment_made` events to the appropriate finalizer.
- `POST /api/checkout/validate-payment`: verify Helcim browser payment payloads for product and training checkout.
- `POST /api/webhooks/card-transactions`: verify Helcim webhooks for product and training checkout.
- `POST /api/training-checkout/square-invoice`: create and publish a Square invoice for a training order when `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`.
- `POST /api/admin/appointments/[id]/no-show`: protected staff command to enforce a no-show charge against a saved card.
- `GET /api/admin/payment-reconciliation`: protected cron/operator route to report stuck or inconsistent booking payment states.

Core modules:

- `src/lib/booking/availability.ts`
- `src/lib/booking/holds.ts`
- `src/lib/booking/finalizer.ts`
- `src/lib/booking/google-calendar.ts`
- `src/lib/booking/google-calendar-event-payload.ts`
- `src/lib/commerce/order-store.ts`
- `src/lib/booking/square-payment-finalizer.ts`
- `src/lib/booking/payments/service-card-on-file.ts`
- `src/lib/booking/payments/service-card-on-file-calendar-finalizer.ts`
- `src/lib/booking/payments/service-card-on-file-no-show-instrument.ts`
- `src/lib/booking/payments/service-payment-alerts.ts`
- `src/lib/booking/payments/service-square-id-resolution.ts`
- `src/lib/booking/payments/service-no-show-policy.ts`
- `src/lib/booking/payments/service-no-show-invoice.ts`
- `src/lib/booking/payments/service-no-show-charge-finalizer.ts`
- `src/lib/booking/payments/service-reconciliation-monitor.ts`
- `src/lib/payments/square/cards-client.ts`
- `src/lib/payments/square/customers-client.ts`
- `src/lib/payments/square/invoice-client.ts`
- `src/lib/payments/square/payments-client.ts`
- `src/lib/commerce/verified-payment.ts`
- `src/lib/commerce/training-enrollment-store.ts`
- `src/lib/commerce/training-square-invoice-finalizer.ts`

## Operational Reconciliation

Minimum operator reporting must identify:

- active holds past expiry,
- paid service orders without Calendar events,
- expired holds that later received payment,
- unmatched Square service webhook events and unmatched Helcim commerce webhook events,
- booking failures requiring manual follow-up,
- paid training tokens that cannot access the Appointment Schedule page,
- Calendar events with no matching DB booking if temporary Calendar holds are ever introduced,
- booked service holds missing a saved Square card, policy acceptance, or no-show charge record,
- failed or declined no-show charges requiring staff follow-up.

## Documentation To Keep In Sync

- `docs/booking-system-architecture-reference.md`
- `docs/booking-system-runbook.md`
- `docs/booking-system-setup-guide.md`
- `docs/booking-payment-provider-split.md`
- `docs/private-database-migration-runbook.md`
- `docs/marketing-contact-privacy-compliance-follow-up.md`
- `docs/launch-readiness-checklist.md`
- `README.md`

## Non-Goals For The First Implementation Pass

- Native Google Appointment Schedule booking as the service-booking engine.
- Stripe payments for booking.
- Multi-staff calendars.
- Self-serve rescheduling/cancellation.
- Refund automation.
- Full admin dashboard, beyond required reconciliation/reporting surfaces.
