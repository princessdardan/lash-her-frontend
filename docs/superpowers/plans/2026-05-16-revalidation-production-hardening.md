# Revalidation Production Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove Sanity webhook revalidation works safely and observably for staging and production content changes.

**Architecture:** Keep `src/app/api/revalidate/route.ts` as the signed Sanity webhook route, preserve raw-body signature validation, map Sanity `_type` values to cache tags, and use immediate Next.js tag expiry.

**Tech Stack:** Next.js 16 App Router, `next/cache`, `next-sanity/webhook`, Sanity webhooks, TypeScript route-handler tests.

---

## Audit Source of Truth

- Feature section: `docs/production-readiness-audit-2026-05-16.md`, lines 131-154.
- Critical blockers: lines 408-413 and 430-434.
- Observability recommendation: lines 450-464.
- Preserve: `parseBody()` before JSON parsing, `isValidSignature !== true` rejection, unknown type no-op, and cache tags for booking settings and sellable products.

## Locked Constraints

- Do not call `req.json()` before `parseBody()`.
- Do not expose webhook failure details in response bodies.
- Do not change `revalidateTag(tag, { expire: 0 })` to deprecated single-arg usage.
- Do not treat unknown document types as hard failures.

## Relevant Files

- `src/app/api/revalidate/route.ts`
- `src/data/loaders.ts`
- `src/sanity/env.ts`
- `tests/`
- `docs/sanity-staging-production-workflow.md`
- Optional: `docs/launch-readiness-checklist.md`

## Recommendation Strengthening

| Audit Recommendation | Gap | Strengthened Requirement | Evidence Required |
| --- | --- | --- | --- |
| Add route-handler tests | Test cases are named but not implemented | Cover valid signature, invalid signature, missing secret, missing `_type`, known type, and unknown type | Passing route-handler test command |
| Manual webhook testing | Manual requirement is vague | Add staging and production smoke steps with endpoint, projection, secret, publish action, expected tag/page | Completed smoke record |
| Improve failure visibility | Console-only failure can be missed | Add structured event/log plan and launch-day watch checklist for 401/400/5xx and repeated failures | Incident checklist owner and log query examples |

## Task 1: Define Route Tests First

**Files:**
- New or existing route test file under `src/app/api/revalidate/` or `tests/`

- [ ] **Step 1: Add valid signature test**

Expected:
- Known `_type` returns 200 and calls `revalidateTag` with the mapped tag and `{ expire: 0 }`.

- [ ] **Step 2: Add rejection tests**

Expected:
- Invalid signature and missing secret return 401; missing `_type` returns 400; response bodies do not leak details.

- [ ] **Step 3: Add unknown type test**

Expected:
- Unknown `_type` returns 200 and does not revalidate a tag.

## Task 2: Align Tag Coverage

**Files:**
- `src/app/api/revalidate/route.ts`
- `src/data/loaders.ts`

- [ ] **Step 1: Compare loader tags to webhook type map**

Expected:
- Every production-relevant Sanity document type with cached public impact has a mapped tag or a documented no-op reason.

- [ ] **Step 2: Add regression note**

Expected:
- Future content types must update loader tags and `TYPE_TAG_MAP` together.

## Task 3: Add Webhook Operations Runbook

**Files:**
- `docs/sanity-staging-production-workflow.md`
- Optional: `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Document Sanity webhook configuration**

Include endpoint, projection `{ _type }`, secret matching, dataset/environment separation, and draft/version policy.

Expected:
- Operators can configure staging and production webhooks without guessing.

- [ ] **Step 2: Document smoke test and backfill response**

Add publish test, expected page update, what logs to inspect, and what to do if a webhook is missed.

Expected:
- Stale content has a clear triage path.

## Final Verification

- [ ] `npm run test:unit` or focused route-handler test command.
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] Staging webhook smoke test passes.
- [ ] Production webhook smoke test is scheduled for controlled launch window.

## Stop Conditions

- Stop if route tests require weakening signature validation.
- Stop if Sanity webhook secret cannot be verified in the target Vercel environment.
- Stop if production publish affects staging or staging publish affects production.

## Suggested Commit Sequence

1. `test: cover sanity revalidation route`
2. `docs: add revalidation webhook runbook`
