# Booking System Architecture Reference

Date: 2026-05-23

This document is the durable reference for the unified Lash Her booking redesign. It complements the implementation plan in `docs/superpowers/plans/2026-05-18-unified-booking-system-redesign.md`.

## Executive Decision

All booking-related flows use app-owned private eligibility and private operational state, but payment and scheduling providers are split by product surface.

Service bookings keep the custom Lash Her slot-selection UI. The app creates private Postgres holds, redirects paid service customers to Square hosted checkout, treats Square browser return as a reconciliation hint only, and finalizes verified Square payments through the Google Calendar API. Product checkout and training checkout remain Helcim-backed and must not require Square environment variables. Paid training intro-call scheduling uses a private app token gate first, then shows a public Google Appointment Schedule link or embed. The app does not mark training as scheduled only because that page renders.

## Decision Record

| Decision | Status | Reason |
| --- | --- | --- |
| Keep custom slot picker for service bookings | Locked | Lash appointments require availability before payment, 10-minute holds, and Square payment before final Calendar booking. |
| Use Square only for service booking payments | Locked | Service booking checkout redirects to Square hosted checkout from a private hold. Square is not the product or training checkout provider. |
| Keep Helcim for product and training checkout | Locked | Product orders and paid training enrollment checkout remain on the existing Helcim commerce flow. |
| Use Google Appointment Schedule only after paid training token eligibility | Locked | Appointment Schedules support public link/embed. The app must gate the URL through private paid token eligibility and must not use Appointment Schedule for service bookings. |
| Keep Google Calendar as final calendar | Locked | Nataliea's operational calendar remains the staff source of truth. |
| Keep Sanity editorial/config only | Locked | Sanity must not store PII, payment state, holds, or booking history. |
| Store lifecycle state in private Postgres | Locked | Holds, payment state, booking state, failures, and reconciliation need durable private audit records. |
| Use a shared idempotent finalizer | Locked | Browser validation and webhooks can both report payment success. |
| Use Redis only for short race locks | Recommended | Redis TTL is useful for contention, but private DB must remain canonical. |
| Adopt Vercel Workflow | Optional | Useful for durable sleeps/hooks/retries, but minimal v1 can use route handlers, private DB, and cron/reconciliation. |

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

| System | Responsibility | Must Not Do |
| --- | --- | --- |
| Sanity | Public/editorial booking offering config, native payment fields, copy | Store PII, holds, payment status, booking history, transaction data |
| Private Postgres | Holds, orders, payment events, booking lifecycle, training eligibility, audit/reconciliation | Act as public CMS |
| Redis / Upstash | Google OAuth token storage and short-lived race locks | Be canonical booking/payment state |
| Google Calendar API | Service booking busy-time source and final staff event store | Gate payment or hold Appointment Schedule slots |
| Google Appointment Schedule | Paid training intro-call scheduling after private token eligibility | Verify paid status, gate the schedule URL, or book service appointments |
| Square | Service booking hosted checkout and payment event source | Act as a global checkout provider for products or training |
| Helcim | Product checkout and training checkout payment event source | Process new service booking payments |
| Resend | Transactional customer/admin emails | Be the source of truth for booking state |

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
  -> Square hosted checkout initialized from hold snapshot
  -> customer returns from Square or Square webhook arrives
  -> server reconciles with Square before trusting payment
  -> verified payment is recorded as paid_calendar_pending
  -> shared finalizer locks order/hold
  -> Google Calendar API event created or found idempotently
  -> hold marked booked with private DB state updated
  -> customer/admin emails sent
```

Square return is not proof of payment. The return route may use query values as lookup hints, but webhook and return handling must reconcile server-side before finalization. Duplicate return and webhook processing must resolve to one private paid state and one Google Calendar event.

## Canonical Flow: Paid Training Intro Call

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

The app does not mark training as scheduled just because the schedule page renders. Invalid, unpaid, expired, or wrong-program tokens must not reveal the Appointment Schedule URL.

## Hold And Booking State Model

Recommended hold states:

| State | Meaning |
| --- | --- |
| `held` | Slot is temporarily reserved before payment. |
| `payment_pending` | Hold is associated with an initialized Square checkout. |
| `paid_pending_booking` | Square payment is verified, Calendar event has not completed yet. |
| `paid_unbookable_rebooking_pending` | Square payment is verified, but the original service slot is expired or unavailable and staff must try rebooking first. |
| `booked` | Google Calendar event exists and booking is confirmed. |
| `expired` | Hold expired before successful payment/finalization. |
| `payment_failed` | Payment attempt failed or verification failed. |
| `booking_failed` | Payment succeeded but Calendar booking failed. |
| `manual_followup` | Staff action is required, usually after paid booking failure or race. |
| `released` | Customer intentionally abandoned/restarted the hold before payment. |

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
- mark related training enrollment scheduled/booked when applicable,
- send emails non-blockingly,
- return the already-confirmed result on duplicate calls.

## Failure Policies

| Failure | Policy |
| --- | --- |
| Two customers select the same slot | Server revalidation plus DB conflict prevention decides winner. |
| Hold expires before payment | Checkout cannot finalize automatically unless the payment success arrives inside the defined grace policy; `payment_pending` holds continue blocking the slot during that grace window. |
| Payment succeeds after slot becomes unavailable | Mark `paid_unbookable_rebooking_pending`; manually rebook first, verify the replacement slot before creating a Calendar event, and refund only after rebooking fails or staff chooses refund. |
| Browser closes after payment | Square webhook can still reconcile payment and run finalization. |
| Client validation and webhook both arrive | Finalizer is idempotent and creates one Calendar event. |
| Calendar insert succeeds but response is lost | Retry searches deterministic metadata before inserting again. |
| Calendar insert fails after payment | Mark `booking_failed` or `manual_followup`; alert/admin surface it. |
| Email fails | Booking remains confirmed; failure is logged/reported. |

## Proposed Route And Module Shape

Names can change during implementation, but keep these boundaries:

- `GET /api/booking/availability`: offering-aware slot availability.
- `POST /api/booking/holds`: create a 10-minute hold after server revalidation.
- `DELETE /api/booking/holds/[id]`: release a hold before payment when safe.
- `POST /api/booking/checkout`: initialize Square hosted checkout for service booking holds using only the hold's selected payment snapshot.
- `GET /api/booking/square/return`: reconcile Square return hints server-side before redirecting to booking confirmation.
- `POST /api/webhooks/square`: verify Square webhook signatures, dedupe events, reconcile payment, and call the shared service booking finalizer.
- `POST /api/checkout/validate-payment`: verify Helcim browser payment payloads for product and training checkout.
- `POST /api/webhooks/card-transactions`: verify Helcim webhooks for product and training checkout.
- `POST /api/booking/reconcile` or scheduled job: expire stale holds and surface recovery states.

Core modules:

- `src/lib/booking/availability.ts`
- `src/lib/booking/holds.ts`
- `src/lib/booking/finalizer.ts`
- `src/lib/booking/google-calendar.ts`
- `src/lib/booking/google-calendar-event-payload.ts`
- `src/lib/commerce/order-store.ts`
- `src/lib/booking/square-payment-finalizer.ts`
- `src/lib/commerce/verified-payment.ts`
- `src/lib/commerce/training-enrollment-store.ts`

## File Impact Map

Likely replace or heavily revise:

- `src/app/(site)/booking/page.tsx`
- `src/components/booking/booking-flow.tsx`
- `src/app/api/booking/create/route.ts`
- `src/lib/booking/booking-service.ts`
- `src/lib/booking/booking-validation.ts`
- `src/lib/booking/types.ts`
- `src/lib/booking/paid-training-context.ts`

Likely extend:

- `src/app/api/booking/availability/route.ts`
- `src/lib/booking/availability.ts`
- `src/lib/booking/google-calendar.ts`
- `src/lib/booking/google-calendar-event-payload.ts`
- `src/app/api/checkout/route.ts`
- `src/app/api/checkout/validate-payment/route.ts`
- `src/app/api/webhooks/card-transactions/route.ts`
- `src/lib/commerce/order-store.ts`
- `src/lib/commerce/training-enrollment-store.ts`
- `src/lib/private-db/schema.ts`
- `src/sanity/schemas/documents/booking-settings.ts`
- `src/sanity/schemas/documents/booking-offering.ts`
- `src/sanity/schemas/documents/service.ts`
- `src/data/loaders.ts`
- `src/types/index.ts`

Likely keep:

- Google OAuth routes and server-side refresh-token handling.
- Helcim checkout primitives.
- Resend email provider boundary.
- Private DB PII/payment boundary.

## Operational Reconciliation

Minimum operator reporting must identify:

- active holds past expiry,
- paid service orders without Calendar events,
- expired holds that later received payment,
- unmatched Square service webhook events and unmatched Helcim commerce webhook events,
- booking failures requiring manual follow-up,
- paid training tokens that cannot access the Appointment Schedule page,
- Calendar events with no matching DB booking if temporary Calendar holds are ever introduced.

## Documentation To Keep In Sync

- `docs/superpowers/plans/2026-05-18-unified-booking-system-redesign.md`
- `docs/booking-system-architecture-reference.md`
- `docs/booking-payment-provider-split.md`
- `docs/private-checkout-storage-setup.md`
- `docs/launch-readiness-checklist.md`
- `README.md`

## Non-Goals For The First Implementation Pass

- Native Google Appointment Schedule booking as the service-booking engine.
- Stripe payments for booking.
- Multi-staff calendars.
- Self-serve rescheduling/cancellation.
- Refund automation.
- Full admin dashboard, beyond required reconciliation/reporting surfaces.
