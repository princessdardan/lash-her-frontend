# Ecommerce Product Catalog Production Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Sanity-backed product catalog launch-safe by confirming launch scope, fixing customer-facing confirmation copy/email behavior, and proving cart/catalog state is server-authoritative.

**Architecture:** Keep Sanity as public catalog/editing source, keep server checkout routes responsible for rebuilding prices and line items from Sanity, and keep private checkout/order records outside Sanity.

**Tech Stack:** Next.js 16 App Router, Sanity, TypeScript, commerce helpers, Playwright, `tsx --test`.

---

## Audit Source of Truth

- Feature section: `docs/production-readiness-audit-2026-05-16.md`, lines 155-175.
- Copy/data blocker: lines 425-428.
- Test blocker: lines 430-434.
- Preserve: server-side total rebuild, cart validation, invalid quantity/variant/product/currency rejection, and money/cart unit coverage.

## Locked Constraints

- Do not trust client prices or client product availability.
- Do not add taxes, discounts, shipping, ACH, partial payments, refunds, saved methods, or customer pre-linking unless the business explicitly approves scope expansion.
- Do not promise a product order email unless implemented and verified.
- Do not expose private checkout records through Sanity or public pages.

## Relevant Files

- `src/sanity/schemas/documents/sellable-product.ts`
- `src/data/loaders.ts`
- `src/lib/commerce/cart.ts`
- `src/lib/commerce/money.ts`
- `src/app/api/checkout/route.ts`
- `src/app/(site)/products/confirmation/page.tsx`
- `src/components/commerce/*`
- `tests/checkout.spec.ts`

## Recommendation Strengthening

| Audit Recommendation | Gap | Strengthened Requirement | Evidence Required |
| --- | --- | --- | --- |
| Confirm first-release scope | Exclusions are acceptable only if business agrees | Record owner decision for taxes, discounts, shipping, refunds, saved methods, and product emails | Decision entry in plan/docs |
| Fix confirmation email promise | Copy and implementation disagree | Either implement product order confirmation email or change confirmation copy to actual behavior | Test or screenshot proving final behavior |
| Product state reflected in UI | Catalog state could drift | Add smoke checks for available/unavailable products, variants, SKUs, and fulfillment copy | Manual or Playwright coverage |

## Task 1: Record Launch Commerce Decisions

**Files:**
- This plan or `docs/launch-readiness-checklist.md`
- Optional README commerce section

- [ ] **Step 1: Confirm excluded commerce features**

Expected:
- Business owner explicitly accepts launch without taxes for general products, discounts, shipping, ACH, partial payments, refunds tooling, saved methods, or customer pre-linking.

- [ ] **Step 2: Decide product order email behavior**

Expected:
- Decision is either “implement email before launch” or “remove promise before launch.”

## Task 2: Define Catalog and Confirmation Tests First

**Files:**
- `tests/checkout.spec.ts`
- Relevant unit test files under `src/lib/commerce`

- [ ] **Step 1: Add confirmation behavior expectation**

Expected:
- Test or manual acceptance explicitly verifies no false email promise remains.

- [ ] **Step 2: Add catalog state acceptance checks**

Expected:
- Coverage verifies unavailable products/variants cannot be checked out and visible catalog state matches Sanity fixtures or smoke content.

## Task 3: Implement Chosen Confirmation Fix

**Files:**
- `src/app/(site)/products/confirmation/page.tsx`
- Optional: `src/lib/email.ts`, checkout/payment verification code, tests

- [ ] **Step 1: If implementing email, add server-side email after verified payment**

Expected:
- Email is sent only after verified payment/order state, failure is logged, and checkout success is not rolled back.

- [ ] **Step 2: If changing copy, remove unsupported promise**

Expected:
- Confirmation page explains the order reference and support follow-up accurately without promising automation.

## Task 4: Add Catalog Smoke Checklist

**Files:**
- `README.md` or `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Add editor-facing product checks**

Expected:
- Checklist covers availability, variants, SKUs, prices, currency, and fulfillment copy.

- [ ] **Step 2: Add checkout authority checks**

Expected:
- Checklist confirms checkout route uses server-derived Sanity product data only.

## Final Verification

- [ ] `npm run test:unit`
- [ ] `npm test -- tests/checkout.spec.ts --project=chromium` or equivalent focused Playwright command.
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] Business decision for excluded commerce features is recorded.

## Stop Conditions

- Stop if business requires taxes, shipping, discounts, refunds, or fulfillment features that are explicitly out of current launch scope.
- Stop if confirmation page promises behavior that is not implemented.
- Stop if checkout tests show client-side prices can affect totals.

## Suggested Commit Sequence

1. `docs: record ecommerce launch scope`
2. `test: cover product confirmation behavior`
3. `fix: align product confirmation copy or email`
