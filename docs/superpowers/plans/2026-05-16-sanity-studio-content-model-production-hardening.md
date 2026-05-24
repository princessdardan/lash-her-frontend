# Sanity Studio and Content Model Production Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Status:** Production-readiness remediation plan based on `docs/production-readiness-audit-2026-05-16.md`.

**Goal:** Prevent invalid launch content from being published and document Sanity token/operator guardrails before production promotion.

**Architecture:** Keep the embedded Studio at `/studio`, keep schemas code-defined and manually registered, keep private checkout/order, marketing/contact, and consent records out of live Studio workflows, and preserve dedicated Sanity clients for public/editorial mutations and legacy/backfill operations.

**Tech Stack:** Sanity v4, next-sanity, TypeScript, GROQ, embedded Studio structure.

---

## Audit Source of Truth

- Feature section: `docs/production-readiness-audit-2026-05-16.md`, lines 109-130.
- Related blockers: lines 408-412, 430-434, 502-510.
- High-priority recommendation: lines 476-483.
- Preserve: checkout orders absent from Studio, private PII docs prohibit new private records in Sanity, and server-only Sanity clients remain separated for public/editorial or legacy/backfill mutations.

## Locked Constraints

- Do not expose checkout orders, payment events, Helcim references, tokens, or checkout PII in Studio.
- Do not expose live marketing contacts, contact submissions, consent events, or raw form payloads in Studio.
- Do not treat legacy Sanity submission document types as current live write targets.
- Do not bypass dedicated Sanity clients for any remaining Sanity mutations.
- Do not rely only on runtime validation for editor-preventable content mistakes.
- Do not broaden Sanity token privileges without documenting scope, environment, and rotation policy.

## Relevant Files

- `src/sanity/schemas/documents/training-program.ts`
- `src/sanity/schemas/documents/product.ts`
- `src/sanity/schemas/index.ts`
- `src/sanity/structure/index.ts`
- `src/sanity/lib/write-client.ts`
- `src/lib/training-checkout.ts`
- `docs/private-checkout-storage-setup.md`
- `docs/sanity-staging-production-workflow.md`
- `docs/private-database-migration-runbook.md`

## Recommendation Strengthening

| Audit Recommendation | Gap | Strengthened Requirement | Evidence Required |
| --- | --- | --- | --- |
| Add editorial guardrail | TODO exists but enforcement is absent | Add Sanity validation ensuring checkout-enabled training programs have native price, availability, fulfillment, and CTA fields | Studio validation test/manual proof and GROQ audit query result |
| Document token least privilege | Plan limits may force broader token role | Record current token purpose, minimum role, deployment environment, owner, and rotation cadence; mark `SANITY_FORM_TOKEN` legacy/conditional only | Token inventory checklist with no secret values |
| Verify Studio production target | Studio can point at wrong dataset | Add launch check proving `/studio` targets intended dataset and schemas are deployed | Screenshot or checklist record for staging and production |
| Submission document types | Legacy schemas may still be registered | Mark `generalInquiry`, `contactForm`, `contactPopupSubmission`, and `bookingMarketingOptIn` as legacy/backfill-only or pending removal/hiding after documented retention decision | Studio/content model checklist |

## Task 1: Define Acceptance Tests First

**Files:**
- `src/sanity/schemas/documents/training-program.ts`
- Optional schema tests if existing test harness supports them
- `docs/sanity-staging-production-workflow.md`

- [ ] **Step 1: Define invalid content scenarios**

List cases for checkout enabled with missing native price, invalid currency, unavailable program state, missing fulfillment copy, or unsupported checkout options.

Expected:
- Editorial validation criteria mirror the runtime guard in `src/lib/training-checkout.ts` where Studio can reasonably enforce them.

- [ ] **Step 2: Define pre-launch audit query**

Write a GROQ query for training programs where `checkoutEnabled == true` and required native checkout fields are missing or invalid.

Expected:
- Operators have a repeatable content audit before launch.

## Task 2: Add Training Checkout Editorial Guardrails

**Files:**
- `src/sanity/schemas/documents/training-program.ts`
- Optional: custom input component under `src/sanity/`

- [ ] **Step 1: Replace TODO with validation implementation**

Use Sanity-supported validation/context or a custom input guard to prevent checkout-enabled training programs from publishing without valid native checkout data.

Expected:
- Editors receive actionable validation before publishing bad training checkout content.

- [ ] **Step 2: Keep runtime guard as defense-in-depth**

Do not remove `src/lib/training-checkout.ts` validation.

Expected:
- Server-side checkout remains authoritative even if Studio validation is bypassed.

## Task 3: Add Token and Studio Operations Checklist

**Files:**
- `docs/sanity-staging-production-workflow.md`
- Optional: `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Document token scope by purpose**

Record `SANITY_WRITE_TOKEN` and `SANITY_WEBHOOK_SECRET` purpose, required environment, minimum feasible role, and rotation owner. Include `SANITY_FORM_TOKEN` only if explicitly retained for legacy/conditional Sanity submission work.

Expected:
- Operators can distinguish current write and webhook credentials from any legacy/conditional form token without exposing secrets.

- [ ] **Step 2: Add Studio launch verification**

Add checks for deployed production schema, embedded `/studio` loading, intended dataset, singleton structure, and no checkout records exposed.

Expected:
- Studio readiness is verified before production promotion.

- [ ] **Step 3: Classify submission document types**

Expected:
- `generalInquiry`, `contactForm`, `contactPopupSubmission`, and `bookingMarketingOptIn` are documented as legacy/backfill-only or explicitly queued for removal/hiding after a retention/redaction decision.

## Final Verification

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] Training checkout validation is manually tested in Studio or covered by a schema validation test.
- [ ] GROQ audit returns zero invalid checkout-enabled training programs.
- [ ] `/studio` targets the intended dataset in staging and production.
- [ ] Studio/token docs do not describe live form writes to Sanity.
- [ ] Sanity submission document types are legacy/backfill-only or pending removal/hiding.

## Stop Conditions

- Stop if Sanity validation cannot inspect referenced product kind; implement a custom guard or pre-publish audit instead of pretending validation is complete.
- Stop if token role cannot be reduced and token isolation/rotation is not documented.
- Stop if any checkout/payment records appear in Studio structure.
- Stop if live private form/contact/consent records are added to Studio without access control, audit logging, and retention policy.

## Suggested Commit Sequence

1. `feat: add training checkout editorial validation`
2. `docs: document sanity token and studio launch checks`
