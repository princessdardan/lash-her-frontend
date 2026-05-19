# Unified Booking System Redesign Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current scheduling-only booking flow and paid training token handoff with one unified booking system for lash appointments, training intro calls, and future booking modes. The new system must show availability before payment, hold selected slots during checkout, verify Helcim payment, and create the final Google Calendar event only after the booking is ready to commit.

**Architecture:** Sanity stores editorial/offering configuration only. Private PostgreSQL stores holds, payment state, booking state, customer snapshots, and audit/reconciliation data. Google Calendar is the final calendar source of truth and is used through Calendar API primitives, not Appointment Schedule booking-page APIs. Helcim remains the payment processor. The old `/booking?token=...` flow is retired.

**Reference:** See `docs/booking-system-architecture-reference.md` for the decision record, state model, flow diagrams, and file impact map.

---

## Supersedes

- `docs/superpowers/plans/2026-05-16-booking-system-production-hardening.md`
- `docs/superpowers/plans/2026-05-16-training-paid-booking-handoff-production-hardening.md`
- The future-work assumptions in `docs/booking-helcim-implementation-summary.md` that say booking and checkout are intentionally separate.

## Locked Product Decisions

- The previous `/booking?token=...` flow will no longer be used.
- All booking-related events and flows go through the new unified booking system.
- Google Calendar Appointment Schedules are not used as customer-facing booking flows for v1. Existing/admin-created pages can be kept only as non-authoritative reference URLs if needed.
- Google Appointment Schedules do not provide the documented API controls needed for Helcim payment gating, 10-minute holds, or programmatic final booking.
- Do not hand customers to Google booking pages or embeds as a post-payment scheduling step in the current system.
- Lash appointment customers must see availability before paying.
- Lash appointments require payment or deposit before final booking.
- Training intro calls require successful training payment before booking.
- Selected slots are held for 10 minutes during checkout.
- Customers cannot change a selected slot once payment starts; changing time restarts the hold/checkout flow.
- If payment succeeds but final Calendar booking fails, the system keeps payment state and marks the booking for manual follow-up instead of losing the payment.
- Google Calendar remains the final staff calendar and receives the committed event after payment/eligibility is verified.
- No customer PII, payment state, hold history, or booking history is stored in Sanity.

## Technical Decisions

- Use Google Calendar `freeBusy.query` and event reads to compute busy time.
- Use `events.insert` to create final Google Calendar events after successful finalization.
- Keep Google OAuth and refresh-token storage server-side through existing booking OAuth infrastructure.
- Use private PostgreSQL as the canonical hold/payment/booking lifecycle store.
- Use Redis only as a short race/concurrency lock, not as the source of truth.
- Use one idempotent booking finalizer for client payment validation and Helcim webhooks.
- Store event/order/hold IDs in a way that allows retries to detect an already-created Calendar event before inserting another one.
- Prefer route handlers, private DB transactions, and cron/reconciliation for minimal v1. If Vercel Workflow is adopted, keep business logic in `"use step"` functions and use workflows only for durable orchestration, sleeps, hooks, and retries.

## Target User Flows

### Lash Appointment Deposit Or Full Payment

1. Customer opens the booking page and selects an offering.
2. App loads Sanity offering settings and private booking constraints.
3. App shows available slots from Google busy data minus active app holds.
4. Customer chooses a slot.
5. Server revalidates availability and creates a 10-minute private hold.
6. Server starts Helcim checkout linked to the hold.
7. Customer completes payment.
8. Client validation and/or Helcim webhook calls the shared finalizer.
9. Finalizer marks the order paid, verifies the hold, creates the Google Calendar event, stores `google_event_id`, marks the hold booked, and sends emails.

### Paid Training Intro Call

1. Customer completes training checkout.
2. Verified payment creates or updates the training enrollment/payment state in private DB.
3. Customer enters the same unified booking system for the training intro-call offering.
4. Eligibility is resolved from private training enrollment/payment state, not from a raw scheduling token URL.
5. Booking uses the same availability, hold, finalizer, Calendar event, and email path as other booking flows.

### Future No-Payment Or Manual Approval Flow

1. Offering config may set `paymentMode` to `none` or `manual`.
2. The system still uses the same availability and booking lifecycle state.
3. Final Calendar event creation happens only after the flow-specific eligibility/approval rule succeeds.

## Data Model Requirements

- Add an `appointment_holds` or equivalent private table with:
  - hold ID and public-safe hold reference
  - offering ID and offering snapshot
  - customer contact snapshot
  - selected start/end/timezone
  - status such as `held`, `payment_pending`, `paid_pending_booking`, `booked`, `expired`, `payment_failed`, `booking_failed`, `manual_followup`, `released`
  - `expires_at`
  - checkout order/payment references
  - Google Calendar event ID
  - timestamps and failure/reconciliation metadata
- Extend private checkout/order state with a booking purpose, such as `product`, `training`, `appointment_deposit`, `appointment_full`, or equivalent.
- Preserve training enrollment records, but remove reliance on raw scheduling-token URLs as the public booking handoff.
- Add Sanity offering configuration either as `bookingOffering` documents or a richer `bookingSettings.offerings[]` model.
- Link offerings to sellable products when payment is required.

## API And Module Surface

Exact route names can change during implementation, but the new system should have these boundaries:

- Availability route: returns slots for a selected offering after applying Calendar busy data and active private holds.
- Hold route: revalidates and creates/releases a 10-minute hold.
- Booking checkout route: starts Helcim checkout for appointment deposit/full-payment flows and links the checkout order to the hold.
- Payment validation route: verifies Helcim browser result and calls the shared finalizer.
- Helcim webhook route: calls the same shared finalizer idempotently.
- Finalizer module: locks the order/hold, records payment, creates or finds the Google Calendar event, marks booking state, and queues/sends emails.
- Reconciliation/cron route or job: expires abandoned holds and reports paid-but-not-booked or booking-failed states.

## Implementation Tasks

## Task 1: Define Tests And Contracts First

**Files:**
- `src/lib/booking/*`
- `src/app/api/booking/*`
- `src/app/api/checkout/validate-payment/route.ts`
- `src/app/api/webhooks/card-transactions/route.ts`
- `tests/booking.spec.ts`

- [ ] **Step 1: Add lifecycle contract tests**

Expected:
- Tests cover hold creation, hold expiry, payment success finalization, duplicate client/webhook finalization, Calendar failure after payment, and slot conflict.

- [ ] **Step 2: Add training eligibility contract tests**

Expected:
- Training intro-call booking eligibility comes from paid private enrollment/order state, not from `/booking?token=...`.

## Task 2: Model Booking Offerings In Sanity

**Files:**
- `src/sanity/schemas/documents/booking-settings.ts`
- `src/sanity/schemas/documents/sellable-product.ts`
- `src/data/loaders.ts`
- `src/types/index.ts`

- [ ] **Step 1: Add offering-level configuration**

Expected:
- Offerings support slug, title, duration, payment mode, deposit/full payment product reference, buffers, lead time, and active state.

- [ ] **Step 2: Preserve public/editorial boundary**

Expected:
- Sanity stores no customer PII, payment status, holds, booking history, or transaction data.

## Task 3: Add Private Booking Lifecycle Storage

**Files:**
- `src/lib/private-db/schema.ts`
- `drizzle/*`
- `src/lib/booking/*`
- `docs/private-checkout-storage-setup.md`

- [ ] **Step 1: Add hold/booking state tables**

Expected:
- Private DB can represent active holds, expired holds, paid pending booking, booked, booking failed, and manual follow-up states.

- [ ] **Step 2: Add conflict-safe hold creation**

Expected:
- Creating a hold expires stale conflicting holds in a transaction and prevents two active holds for the same offering/time.

## Task 4: Build Availability And Hold Flow

**Files:**
- `src/lib/booking/availability.ts`
- `src/lib/booking/google-calendar.ts`
- `src/app/api/booking/availability/route.ts`
- New hold route/module as needed

- [ ] **Step 1: Compute slots from Calendar busy time plus active holds**

Expected:
- Availability excludes Google busy intervals and private active holds.

- [ ] **Step 2: Create 10-minute holds**

Expected:
- Hold creation revalidates selected slot server-side and returns a public-safe hold reference for checkout.

## Task 5: Integrate Helcim With Booking Finalization

**Files:**
- `src/app/api/checkout/route.ts`
- `src/app/api/checkout/validate-payment/route.ts`
- `src/app/api/webhooks/card-transactions/route.ts`
- `src/lib/commerce/*`
- `src/lib/booking/*`

- [ ] **Step 1: Link checkout orders to holds**

Expected:
- Appointment checkout creates a pending private order tied to a valid hold and offering snapshot.

- [ ] **Step 2: Add shared idempotent finalizer**

Expected:
- Client validation and webhook can both arrive safely; only one final Calendar event is created.

- [ ] **Step 3: Handle paid-but-not-booked states**

Expected:
- Calendar failure after payment marks `booking_failed` or `manual_followup` and alerts/admin-surfaces it.

## Task 6: Retire Legacy Training Booking Token Flow

**Files:**
- `src/lib/commerce/training-enrollment-store.ts`
- `src/lib/booking/paid-training-context.ts`
- `src/app/(site)/training-programs/[slug]/confirmation/page.tsx`
- `src/app/(site)/booking/page.tsx`
- `src/components/booking/booking-flow.tsx`

- [x] **Step 1: Remove `/booking?token=...` as a booking path**

Expected:
- No customer-facing booking flow depends on a raw token query parameter.

- [ ] **Step 2: Route paid training intro calls through unified booking**

Expected:
- Training intro-call eligibility and booking completion use private paid enrollment/order state and the shared finalizer.

## Task 7: Update Customer UI And Email Paths

**Files:**
- `src/app/(site)/booking/page.tsx`
- `src/components/booking/*`
- `src/lib/booking/email.ts`
- `src/lib/commerce/*email*`

- [ ] **Step 1: Build offering-first booking UX**

Expected:
- Customers select offering, see slots, hold a slot, pay if required, and receive clear confirmed/manual-follow-up states.

- [ ] **Step 2: Update transactional email content**

Expected:
- Emails distinguish held, paid, booked, manual follow-up, and training intro-call states.

## Task 8: Add Reconciliation And Operator Visibility

**Files:**
- `src/app/api/*`
- `docs/launch-readiness-checklist.md`
- `docs/private-checkout-storage-setup.md`

- [ ] **Step 1: Add hold expiry/reconciliation job**

Expected:
- Abandoned holds expire, stale paid-pending-booking states are reported, and unmatched Helcim webhooks are recoverable.

- [ ] **Step 2: Add operator queries/runbook**

Expected:
- Operators can find paid orders without Calendar events, expired holds with late payments, booking failures, and paid training enrollments not yet booked.

## Task 9: Update Docs And Remove Conflicting Assumptions

**Files:**
- `docs/*`
- `docs/superpowers/plans/*`
- `README.md`

- [ ] **Step 1: Update historical docs with supersession notes**

Expected:
- Future agents cannot mistake the scheduling-only or `/booking?token=...` plans as current product direction.

- [ ] **Step 2: Update launch smoke matrix**

Expected:
- Launch smoke covers unified booking, Helcim payment, final Calendar event creation, duplicate finalizer inputs, and manual-follow-up failure states.

## Final Verification

- [ ] Focused lifecycle/unit tests pass.
- [ ] Focused route-handler tests pass.
- [ ] `npm run test:unit`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] Playwright covers the customer booking happy path.
- [ ] Manual staging smoke proves availability, hold, Helcim payment, Google Calendar event, emails, duplicate finalizer safety, and booking-failure reconciliation.

## Stop Conditions

- Stop if a booking can be finalized without server-side hold and availability revalidation.
- Stop if Helcim payment can mark a booking confirmed without a durable private record.
- Stop if duplicate client/webhook events can create duplicate Google Calendar events.
- Stop if any live booking flow depends on `/booking?token=...`.
- Stop if customer PII, payment status, hold state, or booking history is written to Sanity.
- Stop if paid-but-not-booked state is not visible/recoverable.

## Suggested Commit Sequence

1. `docs: define unified booking redesign`
2. `test: cover booking hold lifecycle`
3. `feat: add private booking hold storage`
4. `feat: model booking offerings`
5. `feat: add booking hold and checkout flow`
6. `feat: finalize bookings after verified payment`
7. `feat: migrate training calls to unified booking`
8. `test: cover unified booking e2e`
