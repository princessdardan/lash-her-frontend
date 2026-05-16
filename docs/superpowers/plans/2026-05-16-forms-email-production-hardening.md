# Forms and Email Production Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify all public form and email paths with real production-like credentials, add abuse controls, and document token/sender operations before launch.

**Architecture:** Keep server actions as the form boundary, validate on client and server, write to Sanity before sending email, and keep email failures non-blocking after successful writes.

**Tech Stack:** Next.js server actions, Sanity form client, Resend, TypeScript validation helpers, optional rate limit/bot protection.

---

## Audit Source of Truth

- Feature section: `docs/production-readiness-audit-2026-05-16.md`, lines 272-288.
- Resend blocker: lines 420-423.
- Email checklist: lines 541-550.
- P1 rate-limit recommendation: line 579.
- Preserve: duplicate server validation, Sanity write failure blocks success, email failure does not roll back success, and separate form tokens.

## Locked Constraints

- Do not send email before a successful Sanity form write.
- Do not expose Sanity tokens or Resend API keys to the browser.
- Do not make email delivery failure roll back a successful Sanity submission.
- Do not silently broaden Sanity token privileges without documenting plan constraints.

## Relevant Files

- `src/app/actions/form.ts`
- `src/lib/form-validation.ts`
- `src/lib/email.ts`
- `src/sanity/lib/form-client.ts`
- Contact/training form components
- `docs/sanity-staging-production-workflow.md`
- `README.md`

## Recommendation Strengthening

| Audit Recommendation | Gap | Strengthened Requirement | Evidence Required |
| --- | --- | --- | --- |
| Verify env and email | “Requires real vars” is broad | Add per-flow smoke checks for general inquiry, training contact, booking confirmation, training payment, and product order decision | Completed smoke record with timestamps and recipients |
| Add spam/rate-limit layer | No explicit control exists | Add rate limit/bot protection at public form boundaries or document accepted launch risk with owner signoff | Tests or decision record |
| Token permissions | Plan constraints may broaden token | Document purpose, minimum role, deployment scope, and rotation cadence for `SANITY_FORM_TOKEN` | Token inventory without secret values |

## Task 1: Define Form and Email Tests First

**Files:**
- `src/app/actions/form.ts`
- `src/lib/form-validation.ts`
- Existing or new tests for form actions/email behavior

- [ ] **Step 1: Cover write-before-email behavior**

Expected:
- Sanity write failure prevents success and skips email; email failure after write logs but returns form success if intended.

- [ ] **Step 2: Cover validation parity**

Expected:
- Server rejects invalid fields even if client validation is bypassed.

## Task 2: Add Abuse Controls

**Files:**
- `src/app/actions/form.ts`
- Optional shared rate-limit helper
- Optional Upstash Redis usage

- [ ] **Step 1: Choose control**

Select rate limiting, honeypot, captcha, or accepted launch risk with owner signoff.

Expected:
- Public forms have explicit spam posture.

- [ ] **Step 2: Implement or document decision**

Expected:
- If implemented, tests cover blocked/allowed submissions; if deferred, launch checklist identifies monitoring and manual mitigation.

## Task 3: Verify Resend and Sender Setup

**Files:**
- `README.md`
- `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Add domain/sender checks**

Expected:
- Resend domain verified, `FROM_EMAIL` aligns with verified domain, and `ADMIN_EMAIL` is correct.

- [ ] **Step 2: Add all email path smoke checks**

Expected:
- General inquiry, training contact, booking confirmation, training payment, and product order confirmation decision are verified.

## Task 4: Document Form Token Operations

**Files:**
- `docs/sanity-staging-production-workflow.md`
- `.env.local.example`

- [ ] **Step 1: Document `SANITY_FORM_TOKEN` scope**

Expected:
- Token role, environment restriction, purpose, rotation owner, and plan limitation are documented.

## Final Verification

- [ ] Focused form action/unit tests pass.
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] Staging smoke submits general inquiry and training contact with real Sanity/Resend credentials.
- [ ] Email delivery/failure behavior is verified without logging secrets.

## Stop Conditions

- Stop if Sanity form writes fail in staging with production-like credentials.
- Stop if verified sender/domain cannot be configured before launch.
- Stop if public forms receive unmitigated spam during staging smoke and no owner risk acceptance exists.

## Suggested Commit Sequence

1. `test: cover form action email boundaries`
2. `feat: add public form abuse controls`
3. `docs: add resend and form token launch checks`
