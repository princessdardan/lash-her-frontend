# Square Card-on-File Production Readiness Runbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a standalone markdown runbook that explains how to move Square card-on-file service booking from staging NO-GO to approved production enablement with safe evidence.

**Architecture:** This is a documentation-only change. The new runbook will reference existing certification, launch-readiness, booking setup, and production cutover docs without changing application behavior. Verification is performed by comparing the runbook’s commands, routes, environment variables, and status names against the codebase and existing docs.

**Tech Stack:** Markdown, Next.js 16 route conventions, Vercel preview/production environments, Square sandbox/production, private PostgreSQL/Drizzle, existing npm scripts.

---

## File Structure

- Create: `docs/square-card-on-file-production-readiness-runbook.md`
  - Standalone operator runbook for staging certification, reconciliation validation, approval, and production enablement guardrails.
- Reference only: `docs/superpowers/reports/square-card-on-file-sandbox-certification.md`
  - Existing evidence report that operators must fill in.
- Reference only: `docs/square-service-booking-setup.md`
  - Existing service-booking setup and certification-order guide.
- Reference only: `docs/launch-readiness-checklist.md`
  - Existing launch smoke matrix and card-on-file production gate.
- Reference only: `docs/production-cutover-checklist.md`
  - Existing broader production cutover checklist.
- Reference only: `scripts/check-square-card-on-file-env.mjs`
  - Env validation script to verify required variable names and environment rules.
- Reference only: relevant route/test files discovered during verification.

## Task 1: Write the standalone runbook

**Files:**

- Create: `docs/square-card-on-file-production-readiness-runbook.md`

- [ ] **Step 1: Draft the runbook with safety gates first**

  Include these sections in order:

  ```markdown
  # Square Card-on-File Production Readiness Runbook

  ## Purpose

  ## Current status

  ## Non-negotiable safety rules

  ## Required staging environment

  ## Staging preparation sequence

  ## Automated checks to run and record

  ## Live Square sandbox certification scenarios

  ## Reconciliation route and cron validation

  ## Certification report approval rules

  ## Production enablement after approval only

  ## First live booking monitoring

  ## Safe evidence and redaction appendix

  ## Operator checklist
  ```

- [ ] **Step 2: Include exact approved go/no-go decision lines**

  The runbook must include both exact strings:

  ```markdown
  Decision: Do not enable production. Reason: one or more required sandbox/staging rows remain pending or failed.
  ```

  ```markdown
  Decision: Approved for production enablement. Reason: all required automated, DB-backed, Square sandbox, staging webhook, and reconciliation checks passed with no unresolved manual-followup states.
  ```

- [ ] **Step 3: Include all nine sandbox scenarios**

  The scenario list must contain:
  1. Web Payments SDK STORE tokenization
  2. Cards API save
  3. Draft no-show invoice/order
  4. Admin exact amount charge
  5. Webhook charged finalization
  6. Declined/failed charge
  7. Publish timeout recovery
  8. Legacy Payment Link fallback
  9. Training Square invoice event

- [ ] **Step 4: Save the runbook**

  Save the complete content to `docs/square-card-on-file-production-readiness-runbook.md`.

## Task 2: Verify setup details against the codebase

**Files:**

- Read: `package.json`
- Read: `scripts/check-square-card-on-file-env.mjs`
- Search/read: route files under `src/app/api/**`
- Search/read: Square booking/payment files under `src/lib/booking/**`
- Search/read: tests named in the runbook
- Read: existing docs referenced by the runbook

- [ ] **Step 1: Confirm npm scripts exist**

  Verify these commands are present or backed by files:

  ```bash
  npm run check:square-card-on-file-env
  npm run lint
  npm run test:unit
  npm run build
  npx playwright test tests/booking.spec.ts --project=chromium
  npx playwright test tests/booking-card-on-file-config.spec.ts --project=chromium
  npx tsx --test src/lib/private-db/card-on-file-repository.db.test.ts src/lib/booking/payments/service-reconciliation-monitor.test.ts
  ```

- [ ] **Step 2: Confirm env var names match validation code**

  Compare the runbook’s required environment variables with `scripts/check-square-card-on-file-env.mjs`. The runbook should not include variable names that conflict with the script.

- [ ] **Step 3: Confirm route names and auth concepts match source**

  Verify the reconciliation endpoint, Square webhook endpoint, Square return route, card-on-file booking route, and admin no-show route names against `src/app/api/**`.

- [ ] **Step 4: Confirm status names match source/docs**

  Verify `charged`, `charge_failed`, `charge_pending`, and `manual_followup` are valid documented/application states before retaining them in the runbook.

- [ ] **Step 5: Patch inaccuracies only**

  If any route, command, variable, or status is inaccurate, edit `docs/square-card-on-file-production-readiness-runbook.md` to match source truth.

## Task 3: Final documentation review

**Files:**

- Review: `docs/square-card-on-file-production-readiness-runbook.md`

- [ ] **Step 1: Scan for unsafe evidence examples**

  Confirm the runbook prohibits raw card tokens, source IDs, access tokens, webhook secrets, signatures, `DATABASE_URL`, admin setup URLs, and PII.

- [ ] **Step 2: Scan for placeholders**

  Confirm the runbook contains no `TBD`, `TODO`, incomplete sections, or ambiguous “fill in later” instructions.

- [ ] **Step 3: Summarize verification evidence**

  Report which files were checked and what corrections, if any, were made.

## Execution Notes

- Do not paste secrets into commands, docs, chat, tickets, or shell history.
- Do not run staging/protected endpoints unless secure staging secrets are already present in the operator’s environment.
- Do not commit unless the user explicitly requests a commit.
