# Booking System Architecture Reference

Date: 2026-05-18

This document is the durable reference for the unified Lash Her booking redesign. It complements the implementation plan in `docs/superpowers/plans/2026-05-18-unified-booking-system-redesign.md`.

## Executive Decision

All booking-related flows will move to a new unified booking system. The historical scheduling-only flow and the paid training `/booking?token=...` handoff are retired.

The new system uses Lash Her-owned slot selection, private holds, Helcim payment, and server-created Google Calendar events. Google Calendar Appointment Schedules are not the booking engine for paid flows because the documented Google APIs do not provide Helcim payment integration, programmatic slot holds, or programmatic Appointment Schedule booking-page control.

## Decision Record

| Decision | Status | Reason |
| --- | --- | --- |
| Retire `/booking?token=...` | Locked | All booking flows must go through one system; tokenized handoff creates a parallel flow to maintain and audit. |
| Use custom slot picker for paid bookings | Locked | Lash appointments require availability before payment, 10-minute holds, and Helcim payment before booking. |
| Do not use Google Appointment Schedules as a current customer-facing booking flow | Locked | Appointment Schedules support link/embed and Stripe payment, but no documented Helcim, hold, or programmable booking API. All booking flows now belong in the unified system. |
| Keep Google Calendar as final calendar | Locked | Nataliea's operational calendar remains the staff source of truth. |
| Keep Sanity editorial/config only | Locked | Sanity must not store PII, payment state, holds, or booking history. |
| Store lifecycle state in private Postgres | Locked | Holds, payment state, booking state, failures, and reconciliation need durable private audit records. |
| Use Helcim for payment | Locked | Existing checkout integration and business requirement use Helcim, not Stripe. |
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

Google Calendar does not expose documented Appointment Schedule APIs for:

- creating temporary booking-page holds,
- booking an Appointment Schedule slot programmatically,
- collecting Helcim payments inside the Google booking page,
- returning Google's precomputed booking-page slots,
- arbitrary customer-info prefill in the embed.

Implication: paid Lash Her booking must be a custom app flow that uses Google Calendar as a calendar backend, not as the customer-facing scheduling engine.

## System Boundaries

| System | Responsibility | Must Not Do |
| --- | --- | --- |
| Sanity | Public/editorial booking offering config, native payment fields, copy | Store PII, holds, payment status, booking history, transaction data |
| Private Postgres | Holds, orders, payment events, booking lifecycle, training eligibility, audit/reconciliation | Act as public CMS |
| Redis / Upstash | Google OAuth token storage and short-lived race locks | Be canonical booking/payment state |
| Google Calendar | Busy-time source and final staff event store | Gate Helcim payment or hold Appointment Schedule slots |
| Helcim | Deposit/full-payment checkout and payment event source | Decide final booking state alone |
| Resend | Transactional customer/admin emails | Be the source of truth for booking state |

## Canonical Flow: Paid Lash Appointment

```text
Offering selected
  -> availability requested
  -> Google busy intervals loaded
  -> active private holds loaded
  -> slots displayed
  -> slot selected
  -> server revalidates slot
  -> private 10-minute hold created with selected payment snapshot
  -> Helcim checkout initialized from hold snapshot
  -> payment success from client and/or webhook
  -> shared finalizer locks order/hold
  -> payment verified and recorded
  -> Google Calendar event created or found
  -> hold marked booked
  -> customer/admin emails sent
```

## Canonical Flow: Paid Training Intro Call

```text
Training checkout completed
  -> payment verified
  -> training enrollment/order marked paid in private DB
  -> customer enters unified booking system for training intro-call offering
  -> eligibility resolved from private paid enrollment/order state
  -> slot selected and held
  -> finalizer creates Google Calendar event
  -> enrollment marked booked/scheduled
  -> confirmation email sent
```

No step uses `/booking?token=...`, and no step hands the customer to a Google booking page or embed as the booking handoff.

## Hold And Booking State Model

Recommended hold states:

| State | Meaning |
| --- | --- |
| `held` | Slot is temporarily reserved before payment. |
| `payment_pending` | Hold is associated with an initialized checkout. |
| `paid_pending_booking` | Payment is verified, Calendar event has not completed yet. |
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
- checkout order/payment references,
- Google Calendar event ID,
- failure reason/reconciliation metadata,
- timestamps.

## Finalizer Requirements

The finalizer is the only code path that confirms paid booking flows.

It must:

- accept payment success from both browser validation and Helcim webhooks,
- lock the relevant order/hold rows,
- verify payment amount, currency, approval, invoice/order identity, and transaction ID,
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
| Payment succeeds after slot becomes unavailable | Mark `manual_followup`; offer another slot before refund. |
| Browser closes after payment | Helcim webhook can still run finalizer. |
| Client validation and webhook both arrive | Finalizer is idempotent and creates one Calendar event. |
| Calendar insert succeeds but response is lost | Retry searches deterministic metadata before inserting again. |
| Calendar insert fails after payment | Mark `booking_failed` or `manual_followup`; alert/admin surface it. |
| Email fails | Booking remains confirmed; failure is logged/reported. |

## Proposed Route And Module Shape

Names can change during implementation, but keep these boundaries:

- `GET /api/booking/availability`: offering-aware slot availability.
- `POST /api/booking/holds`: create a 10-minute hold after server revalidation.
- `DELETE /api/booking/holds/[id]`: release a hold before payment when safe.
- `POST /api/booking/checkout`: initialize Helcim checkout for a hold using only the hold's selected payment snapshot.
- `POST /api/checkout/validate-payment`: verify browser payment payload and call finalizer.
- `POST /api/webhooks/card-transactions`: verify webhook and call finalizer.
- `POST /api/booking/reconcile` or scheduled job: expire stale holds and surface recovery states.

Core modules:

- `src/lib/booking/availability.ts`
- `src/lib/booking/holds.ts`
- `src/lib/booking/finalizer.ts`
- `src/lib/booking/google-calendar.ts`
- `src/lib/booking/google-calendar-event-payload.ts`
- `src/lib/commerce/order-store.ts`
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
- paid orders without Calendar events,
- expired holds that later received payment,
- unmatched Helcim webhook events,
- booking failures requiring manual follow-up,
- paid training enrollments not yet booked,
- Calendar events with no matching DB booking if temporary Calendar holds are ever introduced.

## Documentation To Keep In Sync

- `docs/superpowers/plans/2026-05-18-unified-booking-system-redesign.md`
- `docs/booking-system-architecture-reference.md`
- `docs/booking-helcim-implementation-summary.md`
- `docs/private-checkout-storage-setup.md`
- `docs/launch-readiness-checklist.md`
- `README.md`

## Non-Goals For The First Implementation Pass

- Native Google Appointment Schedule booking as the paid-booking engine.
- Stripe payments for booking.
- Multi-staff calendars.
- Self-serve rescheduling/cancellation.
- Refund automation.
- Full admin dashboard, beyond required reconciliation/reporting surfaces.
