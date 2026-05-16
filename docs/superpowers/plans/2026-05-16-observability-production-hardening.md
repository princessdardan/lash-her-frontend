# Logging, Monitoring, and Observability Production Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure production failures in checkout, webhook, booking, revalidation, forms, and email are detected quickly and can be triaged without exposing secrets.

**Architecture:** Preserve generic user-facing errors, improve machine-readable operational signals, define launch-day log ownership, and plan longer-term structured logging/log drain/alerts.

**Tech Stack:** Next.js route handlers/server actions, Vercel runtime logs, optional structured logger, optional log drain/external alerting provider.

---

## Audit Source of Truth

- Feature section: `docs/production-readiness-audit-2026-05-16.md`, lines 324-346.
- High-priority observability recommendation: lines 450-464.
- Operations checklist: lines 552-560.
- Preserve: meaningful non-secret contexts in payment/webhook logs and generic user-facing responses.

## Locked Constraints

- Do not log secrets, raw tokens, raw payment payloads, full webhook bodies, card/bank data, or unnecessary PII.
- Do not expose internal errors in public responses.
- Do not build an internal order/support dashboard until access control, audit logging, and retention are defined.
- Do not claim production readiness based on manual log reading alone once payment volume scales.

## Relevant Files

- `src/app/api/checkout/route.ts`
- `src/app/api/checkout/validate-payment/route.ts`
- `src/app/api/training-checkout/route.ts`
- `src/app/api/webhooks/card-transactions/route.ts`
- `src/app/api/revalidate/route.ts`
- `src/app/api/booking/*/route.ts`
- `src/app/actions/form.ts`
- `src/lib/booking/*`
- `src/components/custom/layouts/block-renderer.tsx`

## Recommendation Strengthening

| Audit Recommendation | Gap | Strengthened Requirement | Evidence Required |
| --- | --- | --- | --- |
| Configure log access | “Read Vercel logs” lacks ownership | Assign launch-day monitor, log views/queries, escalation contacts, and watch windows | Launch watch checklist |
| Add structured logging | Broad recommendation | Add event names, severity, request/correlation IDs, safe metadata, and redaction rules | Logger interface and migrated critical paths |
| Add alerts | Alert targets named but no thresholds | Define thresholds for repeated webhook 5xx, validation 5xx, booking failures, revalidation 401/5xx, and email failures | Alert config or post-launch backlog with owner |
| Add health checks | “Manual health checks” vague | Add explicit payment and booking health-check runbooks/scripts that avoid side effects or run in staging only | Command/runbook output |

## Task 1: Define Observability Acceptance Criteria First

**Files:**
- `docs/launch-readiness-checklist.md`
- Optional logging helper/tests

- [ ] **Step 1: Define critical event names**

Expected:
- Events include checkout init failure, payment verification failure, webhook rejected/processed, booking create failure, revalidation rejected, and email send failure.

- [ ] **Step 2: Define safe metadata contract**

Expected:
- Logs can include order ID/event ID/document type/request ID, but not secrets, raw tokens, full payloads, or unnecessary PII.

## Task 2: Add Launch-Day Watch Runbook

**Files:**
- `docs/launch-readiness-checklist.md` or `docs/production-incident-runbook.md`

- [ ] **Step 1: Assign monitoring owner and windows**

Expected:
- A named role watches logs during launch and first payment/booking smoke tests.

- [ ] **Step 2: Add incident checklists**

Expected:
- Failed checkout, failed webhook, failed booking, failed revalidation, and failed email each have triage steps and escalation.

## Task 3: Add Structured Logging Foundation

**Files:**
- Optional: `src/lib/logger.ts`
- Critical route handlers/server actions

- [ ] **Step 1: Introduce logger interface**

Expected:
- Critical paths log JSON-like event records with event name, severity, correlation/request ID if available, and safe metadata.

- [ ] **Step 2: Migrate critical paths first**

Expected:
- Checkout, payment validation, Helcim webhook, booking create, revalidation, and form/email paths emit structured events.

## Task 4: Plan Log Retention and Alerts

**Files:**
- `docs/launch-readiness-checklist.md`
- Optional Vercel/log provider docs

- [ ] **Step 1: Decide log retention target**

Expected:
- Vercel runtime log retention limits are documented and a log drain/external provider is selected or explicitly deferred.

- [ ] **Step 2: Define alert thresholds**

Expected:
- Repeated 5xx/401/payment/booking/email failure thresholds have owner, channel, and response target.

## Final Verification

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] Manual staging smoke confirms logs are emitted for success and controlled failure cases.
- [ ] Launch-day watch checklist has an assigned owner.
- [ ] No new logs print secrets or raw private payloads.

## Stop Conditions

- Stop if adding logs would expose tokens or payment/PII payloads.
- Stop if production payments are accepted without someone assigned to monitor launch logs.
- Stop if failure triage depends on an unbuilt admin dashboard.

## Suggested Commit Sequence

1. `docs: add production incident watch runbook`
2. `feat: add structured logger for critical paths`
3. `docs: record log retention and alerting plan`
