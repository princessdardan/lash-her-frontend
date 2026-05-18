# Training Programs and Paid Booking Handoff Production Hardening Plan

> **2026-05-18 status:** Superseded for future implementation by `docs/superpowers/plans/2026-05-18-unified-booking-system-redesign.md`. Training intro-call scheduling is no longer a separate `/booking?token=...` handoff. All booking-related flows, including paid training calls, must use the new unified booking system with shared holds, payment/finalization, and Google Calendar event creation.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the paid training checkout-to-booking handoff production-ready by closing atomicity/editorial gaps and proving the live paid scheduling path end to end.

**Architecture:** Keep training purchase and booking separate: verified payment creates paid enrollment/scheduling eligibility, while Google Calendar remains the booking source of truth. Paid scheduling links are tokenized, hashed, expiring, and email-matched.

**Tech Stack:** Next.js route handlers, Sanity training/product schemas, Helcim, PostgreSQL/Drizzle, Google Calendar booking, Upstash Redis, Resend, Playwright, `tsx --test`.

---

## Audit Source of Truth

- Feature section: `docs/production-readiness-audit-2026-05-16.md`, lines 212-243.
- Live staging smoke blocker: lines 399-406.
- Google OAuth blocker: lines 414-419.
- Resend blocker: lines 420-423.
- Related recommendations: lines 438-448, 476-483, and 450-464.

## Locked Constraints

- Do not create a Calendar event directly from payment validation.
- Do not allow paid scheduling with an email that differs from checkout email.
- Do not store booking history in Sanity.
- Do not expose raw scheduling tokens in the database.
- Do not add self-serve rescheduling, refunds, payment plans, capacity automation, or admin dashboards without separate approval.

## Relevant Files

- `src/app/api/training-checkout/route.ts`
- `src/app/api/checkout/validate-payment/route.ts`
- `src/lib/commerce/training-enrollment-store.ts`
- `src/lib/training-checkout.ts`
- `src/lib/booking/*`
- `src/app/(site)/training-programs/[slug]/confirmation/page.tsx`
- `src/app/(site)/booking/page.tsx`
- `src/sanity/schemas/documents/training-program.ts`
- `src/lib/private-db/schema.ts`

## Recommendation Strengthening

| Audit Recommendation | Gap | Strengthened Requirement | Evidence Required |
| --- | --- | --- | --- |
| Order/enrollment atomicity | Current writes can split | Add transaction/cleanup/reconciliation plan for pending order without enrollment | Test or reconciliation runbook covers split state |
| Editorial validation | Runtime guard catches too late | Add Studio guard and pre-launch GROQ audit | Zero invalid training checkout programs |
| Live handoff test | Manual test is broad | Define exact paid path: checkout, payment, token, booking link, Calendar event, enrollment scheduled, emails | Completed staging smoke record |

## Task 1: Define Handoff Tests First

**Files:**
- Route/unit tests for training checkout and enrollment store
- Playwright training checkout/booking tests or manual smoke checklist

- [ ] **Step 1: Add split-write failure test**

Expected:
- If enrollment creation fails after pending order creation, the system records/logs an actionable state and does not pretend enrollment exists.

- [ ] **Step 2: Add paid scheduling token tests**

Expected:
- Token is issued only after verified paid order, is hashed in DB, expires, and requires matching checkout email.

- [ ] **Step 3: Add booking handoff acceptance check**

Expected:
- Paid token forces training-call booking type and marks enrollment scheduled only after Calendar event creation.

## Task 2: Close Order/Enrollment Atomicity Gap

**Files:**
- `src/app/api/training-checkout/route.ts`
- `src/lib/commerce/training-enrollment-store.ts`
- `src/lib/private-db/*`
- `docs/private-checkout-storage-setup.md`

- [ ] **Step 1: Choose launch-safe approach**

Use a DB transaction if feasible. If Helcim external calls prevent full atomicity, add explicit cleanup/reconciliation for pending orders without enrollment.

Expected:
- Split order/enrollment states are impossible or operationally recoverable.

- [ ] **Step 2: Add operator query**

Expected:
- Runbook can find paid-but-unscheduled, pending-without-enrollment, and expired-token enrollment states.

## Task 3: Add Editorial Guardrail Integration

**Files:**
- `src/sanity/schemas/documents/training-program.ts`
- `docs/sanity-staging-production-workflow.md`

- [ ] **Step 1: Enforce training product references**

Expected:
- Editors cannot publish checkout-enabled training programs pointing to non-training products without a validation warning/block.

- [ ] **Step 2: Add pre-launch GROQ audit**

Expected:
- Operators can verify zero invalid training checkout programs before live payment smoke.

## Task 4: Execute Live Staging Paid Handoff Smoke

**Files:**
- `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Complete paid training checkout**

Expected:
- Pending order and training enrollment are created, payment marks order paid, and scheduling token is issued.

- [ ] **Step 2: Complete tokenized booking**

Expected:
- `/booking?type=training-call&token=...` resolves, enforces email match, creates Calendar event, sends booking email, and marks enrollment scheduled.

- [ ] **Step 3: Verify recovery path**

Expected:
- Training payment email contains a valid recovery scheduling link and expired/used tokens fail safely.

## Final Verification

- [ ] Focused training checkout/enrollment tests pass.
- [ ] `npm run test:unit`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] Live staging paid handoff smoke evidence is recorded.

## Stop Conditions

- Stop if payment success does not issue a scheduling token.
- Stop if booking can be created with a different email from the checkout email.
- Stop if Calendar event creation succeeds but enrollment state is not updated.

## Suggested Commit Sequence

1. `test: cover training checkout handoff failures`
2. `fix: harden training enrollment handoff state`
3. `docs: add paid training booking smoke runbook`
