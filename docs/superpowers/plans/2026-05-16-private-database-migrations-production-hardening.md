# Private Database and Migrations Production Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Database safety constraint:** Do not run production migrations until staging migrations, backups/PITR verification, and rollback planning are complete.

**Goal:** Prove private checkout database readiness by applying migrations safely, documenting target database identity, confirming backups, and planning retention/redaction.

**Architecture:** Keep sensitive checkout records in private PostgreSQL via Drizzle, keep Sanity public-only for catalog/editorial content, and use generated SQL migrations rather than production schema push workflows.

**Tech Stack:** PostgreSQL, Drizzle ORM/drizzle-kit, Vercel envs, npm scripts, private checkout/order repositories.

---

## Audit Source of Truth

- Feature section: `docs/production-readiness-audit-2026-05-16.md`, lines 289-323.
- Critical blocker: lines 393-398.
- Database checklist: lines 512-519.
- P1 retention recommendation: line 580.
- Preserve: sensitive checkout records outside Sanity, unique checkout/scheduling token hashes, payment event idempotency, training enrollment cascade, and separate staging/production DB guidance.

## Locked Constraints

- Do not run `npm run db:migrate` against production without approval and backups/PITR verification.
- Do not use schema push-style workflows for production.
- Do not add an order dashboard until access control, audit logging, and retention policy are defined.
- Do not invent legal retention periods in code.

## Relevant Files

- `drizzle.config.ts`
- `drizzle/*`
- `scripts/migrate-private-db.ts`
- `src/lib/private-db/*`
- `src/lib/commerce/order-store.ts`
- `src/lib/commerce/training-enrollment-store.ts`
- `docs/private-checkout-storage-setup.md`
- `.env.local.example`

## Recommendation Strengthening

| Audit Recommendation | Gap | Strengthened Requirement | Evidence Required |
| --- | --- | --- | --- |
| Run migrations safely | No target proof exists | Add migration checklist recording environment, DB host/branch, migration version, backup/PITR, approver, rollback | Completed staging and production migration records |
| Validate `DATABASE_URL` | Presence check is insufficient | Add safe validation or runbook checks for staging vs production host/branch | Validation output or operator checklist |
| Retention/redaction | Docs defer owner choice | Add owner decision checkpoint and implement redaction job only after requirements are known | Decision record and future task/test plan |

## Task 1: Define Migration Acceptance Checks First

**Files:**
- `docs/private-checkout-storage-setup.md`
- Optional: `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Add migration evidence template**

Expected:
- Template records database provider, host/branch, environment, migration file/version, backup/PITR status, command, timestamp, and approver.

- [ ] **Step 2: Add rollback and failure criteria**

Expected:
- Operators know when to stop, restore, or roll forward after failed migration.

## Task 2: Verify Staging Database Before Production

**Files:**
- `docs/private-checkout-storage-setup.md`
- Optional validation script

- [ ] **Step 1: Apply migrations to staging only**

Expected:
- Staging database has `checkout_orders`, `checkout_payment_events`, and `training_enrollments` with expected migration state.

- [ ] **Step 2: Complete checkout smoke against staging DB**

Expected:
- Product checkout and training checkout create records and can transition to paid/scheduled states.

## Task 3: Plan Production Migration Window

**Files:**
- `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Confirm target production DB**

Expected:
- `DATABASE_URL` points to intended production database, not staging, with SSL requirements intact.

- [ ] **Step 2: Confirm backups/PITR**

Expected:
- Backup/restore capability is verified before migration command is run.

- [ ] **Step 3: Run production migration only after approval**

Expected:
- Migration is executed in a controlled window and evidence is recorded.

## Task 4: Add Retention/Redaction Decision Path

**Files:**
- `docs/private-checkout-storage-setup.md`
- Optional future redaction script/test files

- [ ] **Step 1: Record owner retention decision**

Expected:
- Business/legal retention period is known before implementation of automated redaction.

- [ ] **Step 2: Define redaction behavior**

Expected:
- Future job redacts PII while preserving non-PII reconciliation/accounting fields.

## Final Verification

- [ ] `npm run db:generate` only if schema changed.
- [ ] `npm run db:migrate` applied to staging and recorded.
- [ ] Checkout smoke verifies DB reads/writes in staging.
- [ ] Production backup/PITR verification is recorded before production migration.
- [ ] `npm run lint`
- [ ] `npm run build`

## Stop Conditions

- Stop if `DATABASE_URL` target cannot be independently identified.
- Stop if backups/PITR are unavailable or unverified.
- Stop if migration state differs between repo migrations and database record.

## Suggested Commit Sequence

1. `docs: add private database migration runbook`
2. `chore: strengthen database environment validation`
3. `docs: record checkout retention decision path`
