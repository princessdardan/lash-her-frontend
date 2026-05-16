# Helcim Checkout and Payment Processing Production Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Payment safety constraint:** Do not accept real production payments until route tests, live staging Helcim smoke tests, webhook verification, and reconciliation procedures pass.

**Goal:** Reduce payment launch risk by adding route coverage, live Helcim smoke evidence, webhook replay/freshness decisions, and manual reconciliation for orphaned sessions/orders.

**Architecture:** Keep Helcim API tokens server-only, keep browsers limited to `checkoutToken`, store pending/paid/private order state in PostgreSQL, verify Helcim responses server-side, and fulfill from verified server-side payment state/webhooks.

**Tech Stack:** Next.js route handlers, Helcim v2 API and HelcimPay.js, PostgreSQL with Drizzle, server-side encryption, webhook verification, `tsx --test`, Playwright.

---

## Audit Source of Truth

- Feature section: `docs/production-readiness-audit-2026-05-16.md`, lines 176-211.
- Critical blockers: lines 399-406 and 430-434.
- High-priority recommendations: lines 438-448 and 485-489.
- Preserve: separate Helcim tokens, server-only secrets, browser-only `checkoutToken`, encrypted `secretToken`, webhook idempotency, redacted payload storage, and `verification_failed` state.

## Locked Constraints

- Do not expose Helcim `secretToken`, API tokens, webhook verifier token, raw payment payloads, or full card data to the browser or Sanity.
- Do not mark an order paid from success-page navigation alone.
- Do not add provider migration, refunds, taxes, discounts, shipping, subscriptions, or saved payment methods without owner approval.
- Do not change the webhook URL to include the word `helcim`.

## Relevant Files

- `src/app/api/checkout/route.ts`
- `src/app/api/training-checkout/route.ts`
- `src/app/api/checkout/validate-payment/route.ts`
- `src/app/api/webhooks/card-transactions/route.ts`
- `src/lib/commerce/helcim-client.ts`
- `src/lib/commerce/helcim-hash.ts`
- `src/lib/commerce/helcim-webhook.ts`
- `src/lib/commerce/order-store.ts`
- `src/lib/private-db/*`
- `docs/private-checkout-storage-setup.md`

## Recommendation Strengthening

| Audit Recommendation | Gap | Strengthened Requirement | Evidence Required |
| --- | --- | --- | --- |
| Add reconciliation runbook | Orphan handling is only described conceptually | Add exact queries/checks for pending orders older than threshold, Helcim invoices without local order, and duplicate webhook delivery | Runbook with safe read-only commands and escalation path |
| Add route-handler tests | Critical payment boundaries lack direct tests | Cover checkout init, validation success/failure, missing order, persistence failure, webhook duplicate/replay behavior | Passing focused route tests |
| Review replay tolerance | “Review” lacks decision criteria | Compare current freshness window to Helcim docs/account behavior, then document accepted window or narrow it | Decision note and tests if changed |
| Consider Stripe | Strategic alternative could distract launch | Add post-launch decision checkpoint, not a launch migration | Owner decision backlog item |

## Task 1: Define Payment Boundary Tests First

**Files:**
- New route-handler tests for checkout, training checkout, validate-payment, and webhook routes

- [ ] **Step 1: Add `/api/checkout` tests**

Expected:
- Success uses Sanity-derived products and stores a pending order; failure covers invalid body, cart validation, Helcim failure, and DB persistence failure.

- [ ] **Step 2: Add `/api/checkout/validate-payment` tests**

Expected:
- Success marks paid; invalid hash, missing order, amount/currency/invoice mismatch, and persistence failure are covered.

- [ ] **Step 3: Add webhook route tests**

Expected:
- Valid signature records event idempotently; duplicate delivery is safe; invalid/replayed/stale signature behavior matches the documented decision.

## Task 2: Add Launch Reconciliation Runbook

**Files:**
- `docs/private-checkout-storage-setup.md`
- Optional: `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Define orphan states**

Document Helcim invoice/session succeeded but DB persistence failed, pending order older than threshold, training order without enrollment, and paid Helcim transaction not reflected locally.

Expected:
- Operators know which states require manual investigation.

- [ ] **Step 2: Add safe lookup procedures**

Provide read-only DB queries or dashboard steps without exposing secrets or PII in shared logs.

Expected:
- Launch operators can reconcile failed checkout reports without needing an admin dashboard.

## Task 3: Run Live Staging Helcim Smoke

**Files:**
- `docs/launch-readiness-checklist.md` or README launch section

- [ ] **Step 1: Product checkout smoke**

Expected:
- Staging product checkout creates pending private order, Helcim success marks paid, webhook arrives and records idempotently.

- [ ] **Step 2: Failure smoke**

Expected:
- Failed/invalid payment does not mark paid and leaves actionable private state/logs.

- [ ] **Step 3: Duplicate webhook smoke**

Expected:
- Duplicate delivery does not duplicate payment events or corrupt order state.

## Task 4: Decide Provider Strategy After Launch Evidence

**Files:**
- `docs/booking-helcim-implementation-summary.md` or new decision log

- [ ] **Step 1: Record Helcim launch acceptance criteria**

Expected:
- Helcim remains launch provider only if live staging tests pass and operations can support reconciliation.

- [ ] **Step 2: Add Stripe evaluation backlog**

Expected:
- Stripe is tracked as strategic P2 work, not mixed into launch hardening.

## Final Verification

- [ ] Focused payment route-handler tests pass.
- [ ] `npm run test:unit`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] Live staging Helcim transaction and webhook smoke evidence is recorded.
- [ ] Reconciliation runbook is reviewed by the launch operator.

## Stop Conditions

- Stop if Helcim staging cannot deliver webhooks to the intended endpoint.
- Stop if any paid state can be set from unverified client input.
- Stop if DB persistence failures cannot be detected and reconciled manually before launch.

## Suggested Commit Sequence

1. `test: cover checkout payment route handlers`
2. `docs: add helcim reconciliation runbook`
3. `docs: record payment provider launch decision`
