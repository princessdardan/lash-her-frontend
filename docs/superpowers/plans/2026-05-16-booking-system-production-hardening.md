# Booking System Production Hardening Plan

> **2026-05-18 status:** Superseded for future implementation by `docs/superpowers/plans/2026-05-18-unified-booking-system-redesign.md`. This file remains useful as historical audit context for the existing scheduling-only implementation, but the current product direction is now a unified booking/payment/calendar system. The previous `/booking?token=...` handoff and scheduling-only booking flow must not be extended.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the live Google Calendar booking system, Redis operational state, lock timing, and booking email path before production launch.

**Architecture:** Keep Sanity as booking configuration, Google Calendar as availability/booking source of truth, Upstash Redis as OAuth/lock/idempotency store, and Resend as confirmation email provider.

**Tech Stack:** Next.js route handlers, Google Calendar API/OAuth, Upstash Redis, Sanity booking settings, Resend, Playwright, `tsx --test`.

---

## Audit Source of Truth

- Feature section: `docs/production-readiness-audit-2026-05-16.md`, lines 244-271.
- Critical blockers: lines 399-406 and 414-423.
- Observability recommendation: lines 450-464.
- Preserve: OAuth setup secret, server-side Redis token storage, slot revalidation, lock/idempotency protections, and non-rollback email failures.

## Locked Constraints

- Do not store Google refresh tokens in source code, Sanity, or browser-accessible storage.
- Do not create bookings without server-side availability revalidation.
- Do not store confirmed booking history in Sanity.
- Do not add payments, Meet links, cancellation/rescheduling, approval workflow, or multi-staff calendars unless separately approved.

## Relevant Files

- `src/app/api/booking/oauth/start/route.ts`
- `src/app/api/booking/oauth/callback/route.ts`
- `src/app/api/booking/availability/route.ts`
- `src/app/api/booking/create/route.ts`
- `src/lib/booking/*`
- `src/sanity/schemas/documents/booking-settings.ts`
- `src/lib/booking/email.ts`
- `docs/google-calendar-oauth-env-setup.md`
- `docs/booking-helcim-implementation-summary.md`

## Recommendation Strengthening

| Audit Recommendation | Gap | Strengthened Requirement | Evidence Required |
| --- | --- | --- | --- |
| Verify live OAuth/calendar | Cannot infer from code | Add exact OAuth setup and slot marker smoke for staging and production | Refresh token stored, calendar ID matched, availability visible |
| Review lock TTL | “Probably enough” is not proof | Measure real Google API latency during staging booking smoke and compare to 20s TTL | Recorded max latency and TTL decision |
| Add alerting | Failures are console-only | Add launch-day log watch and post-launch alert plan for Google, Redis, and email failures | Incident checklist owner and queries |

## Task 1: Define Booking Route Tests First

**Files:**
- Route-handler tests for booking availability/create
- Existing booking unit tests

- [ ] **Step 1: Add availability route tests**

Expected:
- Tests cover valid settings, unavailable calendar/OAuth, and no slot marker conditions.

- [ ] **Step 2: Add create route tests**

Expected:
- Tests cover invalid request, conflict/unavailable slot, idempotency duplicate, Calendar failure, Redis failure, and email failure non-rollback.

## Task 2: Verify OAuth and Calendar Setup

**Files:**
- `docs/google-calendar-oauth-env-setup.md`
- `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Add production OAuth checklist**

Include Google API enabled, consent screen, OAuth callback, scopes, setup secret, and Upstash token storage checks.

Expected:
- Launch operator can connect or re-connect the production calendar safely.

- [ ] **Step 2: Add calendar/settings match check**

Expected:
- `bookingSettings.calendarId`, timezone, lead time, horizon, buffers, and booking types match the connected calendar.

## Task 3: Measure Lock TTL Under Real Latency

**Files:**
- `src/lib/booking/*`
- `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Instrument or manually record booking create duration**

Expected:
- Real staging booking create latency is recorded across several attempts.

- [ ] **Step 2: Decide whether 20s lock TTL is sufficient**

Expected:
- If max latency approaches TTL, adjust TTL and tests; otherwise document launch acceptance.

## Task 4: Run Live Booking Smoke

**Files:**
- `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Verify availability markers produce slots**

Expected:
- Public availability endpoint returns expected slots from marker events.

- [ ] **Step 2: Verify booking creation**

Expected:
- Booking creates Google Calendar event, sends confirmation email, and duplicate submissions are idempotent.

- [ ] **Step 3: Verify paid training token path**

Expected:
- Paid token booking path works and invalid/expired token paths fail safely.

## Final Verification

- [ ] Focused booking route/unit tests pass.
- [ ] `npm run test:unit`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] Live staging OAuth/calendar/Redis/email smoke evidence is recorded.

## Stop Conditions

- Stop if Google OAuth cannot store a refresh token in the intended Upstash instance.
- Stop if booking creates a Calendar event without recording success to the caller.
- Stop if lock TTL is exceeded or double-booking is observed in staging.

## Suggested Commit Sequence

1. `test: cover booking route handlers`
2. `docs: add google calendar production smoke checklist`
3. `fix: tune booking lock ttl` if required by latency evidence
