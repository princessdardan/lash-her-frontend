# Testing Production Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close critical route-handler and smoke-test gaps so production readiness is based on boundary tests plus live integration evidence, not mocked E2E flows alone.

**Architecture:** Keep unit tests for pure helpers, add route-handler tests for external boundaries, keep Playwright mocked UX tests, and add separate live/manual smoke checklists for staging integrations.

**Tech Stack:** `tsx --test`, Playwright, Next.js route handlers, Sanity/Helcim/Google/Redis/Resend smoke procedures.

---

## Audit Source of Truth

- Feature section: `docs/production-readiness-audit-2026-05-16.md`, lines 347-381.
- Critical test blocker: lines 430-434.
- Code checks: lines 493-500.
- P1 mock modernization recommendation: line 581.
- Preserve: existing unit coverage for cart, money, Helcim hash/webhook parsing, payment verification, order storage, training token lifecycle, booking availability, Google Calendar payloads, paid booking context, and Helcim webhook route tests.

## Locked Constraints

- Do not delete or weaken failing tests to pass.
- Do not claim live integration readiness from mocked Playwright tests.
- Do not let legacy Strapi mocks imply current Sanity server-side data flow.
- Do not hit live external services from default unit tests.

## Relevant Files

- `package.json`
- `playwright.config.ts`
- `tests/*.spec.ts`
- `tests/utils/api-mocks.ts`
- `src/app/api/checkout/route.ts`
- `src/app/api/training-checkout/route.ts`
- `src/app/api/checkout/validate-payment/route.ts`
- `src/app/api/booking/availability/route.ts`
- `src/app/api/booking/create/route.ts`
- `src/app/api/revalidate/route.ts`

## Recommendation Strengthening

| Audit Recommendation | Gap | Strengthened Requirement | Evidence Required |
| --- | --- | --- | --- |
| Add route-handler tests | Critical APIs lack direct tests | Add tests for checkout, training checkout, payment validation, booking availability/create, and revalidation | Passing focused test command |
| Add live smoke checklist | Manual/live distinction is vague | Create explicit smoke matrix for Sanity, DB, Helcim, webhook, booking, Redis, Google Calendar, and Resend | Completed staging smoke record |
| Modernize mocks | Legacy Strapi mocks mislead maintainers | Rename/remove Strapi-shaped mocks and document Sanity server-side fixture assumptions | Updated test utility names/docs |

## Task 1: Inventory Current Test Coverage

**Files:**
- `tests/`
- `src/**/*.test.ts`
- `package.json`

- [ ] **Step 1: Map tests to critical boundaries**

Expected:
- Matrix shows which critical APIs have unit/route/Playwright/live coverage and which are missing.

- [ ] **Step 2: Add no-`test.only` check**

Expected:
- Launch checklist or script verifies no focused tests remain.

## Task 2: Add Critical Route-Handler Tests

**Files:**
- Route-handler test files for checkout, training checkout, validate-payment, booking, and revalidation

- [ ] **Step 1: Checkout init tests**

Expected:
- `/api/checkout` success/failure and `/api/training-checkout` success/failure/enrollment write failure are covered.

- [ ] **Step 2: Payment validation tests**

Expected:
- Success, invalid hash, missing order, mismatch, and persistence failure are covered.

- [ ] **Step 3: Booking route tests**

Expected:
- Availability and create routes cover success, invalid input, unavailable slot, idempotency, provider failure, and email failure.

- [ ] **Step 4: Revalidation tests**

Expected:
- Valid signature, invalid signature, missing `_type`, and unknown type are covered.

## Task 3: Separate Mocked UX From Live Smoke

**Files:**
- `tests/utils/api-mocks.ts`
- `tests/*.spec.ts`
- `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Modernize mock naming and docs**

Expected:
- Test utilities no longer present legacy Strapi-style mocks as current data-flow proof.

- [ ] **Step 2: Add live integration smoke matrix**

Expected:
- Matrix covers product checkout, training checkout, Helcim webhook, private DB state, scheduling token, booking Calendar event, Sanity revalidation, and Resend emails.

## Task 4: Run Full Launch Validation

**Files:**
- No source files unless failures require fixes

- [ ] **Step 1: Run static and unit checks**

Expected:
- `npm run lint`, `npm run build`, and `npm run test:unit` pass or pre-existing failures are documented.

- [ ] **Step 2: Run Playwright UX checks**

Expected:
- Key Chromium specs for homepage, contact, training, products, checkout, and booking pass.

- [ ] **Step 3: Run live staging smoke checks**

Expected:
- External integration smoke evidence is recorded separately from mocked tests.

## Final Verification

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm run test:unit`
- [ ] `npm test` or documented focused Chromium specs.
- [ ] `rg -n "test.only|describe.only" .` returns no launch-blocking focused tests.
- [ ] Live staging smoke checklist completed before production promotion.

## Stop Conditions

- Stop if route tests require network calls to live services by default.
- Stop if mocked Playwright tests are the only evidence for Helcim/Google/Redis/Resend readiness.
- Stop if legacy mocks cause maintainers to misunderstand current Sanity data flow.

## Suggested Commit Sequence

1. `test: add critical api route coverage`
2. `test: modernize storefront and booking mocks`
3. `docs: add live staging smoke matrix`
