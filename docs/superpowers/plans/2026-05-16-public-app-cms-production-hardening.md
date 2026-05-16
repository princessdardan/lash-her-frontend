# Public App and CMS Production Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Status:** Production-readiness remediation plan based on `docs/production-readiness-audit-2026-05-16.md`. Do not promote staging until the validation tasks are complete.

**Goal:** Make the public Next.js app and Sanity CMS boundary launch-ready by removing stale setup guidance, strengthening environment validation, and proving content publish/revalidation behavior in staging and production.

**Architecture:** Keep Next.js App Router pages as server components, keep `src/data/loaders.ts` as the Sanity read boundary, keep Sanity as the public content source, and keep private checkout records out of Sanity.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Sanity v4/next-sanity, Vercel environments, npm scripts.

---

## Audit Source of Truth

- Feature section: `docs/production-readiness-audit-2026-05-16.md`, lines 86-108.
- Critical blockers: lines 387-391, 408-428, 430-434.
- High-priority recommendation: lines 466-474.
- Preserve: root-level Next.js app, Sanity as CMS, central loaders, cache tags, server-side catalog reads, and no private checkout data in Sanity.

## Locked Constraints

- Do not add a second CMS/data access layer beside `src/data/loaders.ts`.
- Do not reintroduce Strapi, Vercel Blob, or private Motion registry requirements into launch setup.
- Do not weaken staging/production Sanity dataset separation.
- Do not move checkout PII, payment state, or private order records into Sanity.

## Relevant Files

- `.env.local.example`
- `README.md`
- `scripts/validate-sanity-env.mjs`
- `src/data/loaders.ts`
- `src/app/(site)/layout.tsx`
- `src/app/api/revalidate/route.ts`
- `docs/sanity-staging-production-workflow.md`

## Recommendation Strengthening

| Audit Recommendation | Gap | Strengthened Requirement | Evidence Required |
| --- | --- | --- | --- |
| Remove stale env/docs | Operators could configure old services | Rewrite env example and README around the current Sanity, booking, checkout, database, email, and webhook stack | Diff shows no active Strapi/Blob/Motion launch vars; README has operator runbook |
| Validate production env | Current validation checks only dataset | Add or document a full production-critical env validation checklist/script | Passing validation output or completed checklist for preview and production |
| Verify CMS launch behavior | Publish/revalidate behavior is assumed | Add staging and production smoke steps for page/global/menu/content publish flow | Smoke evidence with dataset, content type, webhook status, and page URL |

## Task 1: Define Acceptance Checks First

**Files:**
- `README.md`
- `.env.local.example`
- `scripts/validate-sanity-env.mjs`
- Optional: `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Add docs/env acceptance criteria**

Expected:
- A reviewer can verify that all current launch services are documented and stale launch services are absent.

- [ ] **Step 2: Add environment parity acceptance criteria**

Expected:
- Production requires `NEXT_PUBLIC_SANITY_DATASET=production`; staging/preview requires `staging-2026-05-10`; required Sanity, email, booking, checkout, database, and webhook secrets are listed.

- [ ] **Step 3: Add CMS smoke acceptance criteria**

Expected:
- Content publish smoke covers at least one singleton, one page, one menu/global item, and one sellable/training content document.

## Task 2: Rewrite Launch Setup Documentation

**Files:**
- `.env.local.example`
- `README.md`

- [ ] **Step 1: Replace stale env entries**

Remove active Strapi, Vercel Blob, and Motion registry examples from `.env.local.example` unless clearly marked historical and unused.

Expected:
- Env example only contains variables needed by the current launch stack.

- [ ] **Step 2: Replace README boilerplate**

Write project-specific setup, local development, environment, Sanity, booking, checkout, database, revalidation, and smoke-test guidance.

Expected:
- README is usable as an operator runbook rather than a create-next-app starter file.

## Task 3: Strengthen Environment Validation

**Files:**
- `scripts/validate-sanity-env.mjs`
- Optional: new script under `scripts/`
- `package.json`

- [ ] **Step 1: Decide validation boundary**

Choose whether to extend `validate-sanity-env.mjs` or add a separate production env validation script.

Expected:
- Validation has one canonical command and does not require exposing secret values.

- [ ] **Step 2: Validate critical env presence and environment-specific values**

Validate required Sanity, Resend, Google, Upstash, database, checkout encryption, and Helcim webhook variable presence; validate only safe shape rules for secrets.

Expected:
- Missing production-critical variables fail before deployment or launch smoke.

## Task 4: Prove Public CMS Launch Behavior

**Files:**
- `docs/launch-readiness-checklist.md` or README launch section
- `docs/sanity-staging-production-workflow.md`

- [ ] **Step 1: Add smoke matrix**

Document staging and production smoke checks for homepage, global settings, main menu, training program, sellable product, and booking settings publish flows.

Expected:
- Each smoke step records dataset, document type, webhook delivery, expected cache tag, and public URL.

- [ ] **Step 2: Add stop condition**

State that production promotion stops if a production publish does not appear on the public page after webhook delivery.

Expected:
- Launch checklist blocks promotion on stale content or wrong dataset targeting.

## Final Verification

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] Env validation command passes for preview and production variable sets without printing secret values.
- [ ] README and env example no longer direct operators toward legacy launch services.
- [ ] Manual CMS smoke evidence is recorded for staging before production promotion.

## Stop Conditions

- Stop if production dataset, project ID, webhook secret, or Studio target cannot be verified.
- Stop if a smoke publish updates staging but not production, or vice versa.
- Stop if fixing setup docs would require changing the app data access architecture.

## Suggested Commit Sequence

1. `docs: replace launch setup guidance`
2. `chore: strengthen launch environment validation`
3. `docs: add public cms smoke checklist`
