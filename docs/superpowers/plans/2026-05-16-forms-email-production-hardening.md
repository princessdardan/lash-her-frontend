# Forms and Email Production Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify all public form and email paths with real production-like credentials, add abuse controls, and document token/sender operations before launch.

**Architecture:** Keep server actions as the form boundary, validate on client and server, write to the private DB before sending email, and keep email failures non-blocking after successful writes.

**Tech Stack:** Next.js server actions, private DB-backed marketing/contact storage, Resend, TypeScript validation helpers, optional rate limit/bot protection.

---

## Audit Source of Truth

- Feature section: `docs/production-readiness-audit-2026-05-16.md`, lines 272-288.
- Resend blocker: lines 420-423.
- Email checklist: lines 541-550.
- P1 rate-limit recommendation: line 579.
- Preserve: duplicate server validation, private DB write failure blocks success, email failure does not roll back success, and Sanity submission documents are legacy/backfill-only.

## Locked Constraints

- Do not send email before a successful private DB form/contact write.
- Do not expose database credentials, Sanity tokens, or Resend API keys to the browser.
- Do not make email delivery failure roll back a successful private DB submission.
- Do not write new private form, contact, consent, or marketing records to Sanity.

## Relevant Files

- `src/app/actions/form.ts`
- `src/lib/form-validation.ts`
- `src/lib/email.ts`
- `src/lib/marketing-contact/marketing-contact-store.ts`
- `src/lib/private-db/schema.ts`
- Contact/training form components
- `docs/sanity-staging-production-workflow.md`
- `README.md`

## Recommendation Strengthening

| Audit Recommendation | Gap | Strengthened Requirement | Evidence Required |
| --- | --- | --- | --- |
| Verify env and email | “Requires real vars” is broad | Add per-flow smoke checks for general inquiry, training contact, contact popup, booking confirmation, training payment, and product order decision | Completed smoke record with timestamps and recipients redacted |
| Add spam/rate-limit layer | No explicit control exists | Add rate limit/bot protection at public form boundaries or document accepted launch risk with owner signoff | Tests or decision record |
| Storage evidence | Old plans relied on Sanity submission docs | Add private DB evidence for submissions, consent events, no-opt-in booking choices, and no new Sanity submission docs | Redacted query/log evidence |

## Task 1: Define Form and Email Tests First

**Files:**
- `src/app/actions/form.ts`
- `src/lib/form-validation.ts`
- Existing or new tests for form actions/email behavior

- [ ] **Step 1: Cover private-DB-before-email behavior**

Expected:
- Private DB write failure prevents success and skips email; email failure after write logs but returns form success if intended.
- General inquiry, training contact, contact popup, and booking marketing choice writes produce private DB evidence with PII redacted.

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
- General inquiry, training contact, and contact popup records are verified in private DB tables, not as new Sanity submission documents.

## Task 4: Document Private Form Storage Operations

**Files:**
- `docs/sanity-staging-production-workflow.md`
- `.env.local.example`
- `docs/private-database-migration-runbook.md`

- [ ] **Step 1: Remove live `SANITY_FORM_TOKEN` dependency**

Expected:
- `SANITY_FORM_TOKEN` is absent from current live form-write requirements unless explicitly marked legacy/conditional for old Sanity submission flows.

- [ ] **Step 2: Add consent and no-opt-in acceptance criteria**

Expected:
- Consent evidence includes submitted email, normalized email, source form/path, consent timestamp, displayed consent/CTA text, privacy link snapshot when available, and source system/doc ID for backfill.
- Booking with marketing opt-in and booking without marketing opt-in are both audited.
- No new `generalInquiry`, `contactForm`, `contactPopupSubmission`, or `bookingMarketingOptIn` Sanity documents are created by live flows.

## Final Verification

- [ ] Focused form action/unit tests pass.
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] Staging smoke submits general inquiry, training contact, contact popup, and booking marketing choice with private DB and Resend evidence.
- [ ] Booking smoke covers opted-in and not-opted-in marketing choices.
- [ ] No new Sanity submission documents are created during form smoke checks.
- [ ] Email delivery/failure behavior is verified without logging secrets.

## Stop Conditions

- Stop if private DB form/contact writes fail in staging with production-like credentials.
- Stop if verified sender/domain cannot be configured before launch.
- Stop if live form flows create new Sanity submission documents.
- Stop if public forms receive unmitigated spam during staging smoke and no owner risk acceptance exists.

## Suggested Commit Sequence

1. `test: cover form action email boundaries`
2. `feat: add public form abuse controls`
3. `docs: add resend and private form storage launch checks`
