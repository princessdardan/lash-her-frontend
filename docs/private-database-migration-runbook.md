# Private Database Migration Runbook

This runbook describes how to safely verify, run, and record private PostgreSQL migrations for Lash Her. PostgreSQL stores private operational records and the public operational booking catalog/configuration. Sanity remains the editorial, media, and SEO CMS plus a historical submission backfill source; new private data must not be written to Sanity.

Use this runbook for generated Drizzle migrations in `drizzle/`.

## Scope

Private database migrations cover tables defined in `src/lib/private-db/schema.ts` and applied by `scripts/migrate-private-db.ts`.

Current private DB domains include:

- Checkout orders, payment events, obligations, refunds, stock, shipping, and fulfillment state.
- Operational booking providers, resources, offerings, schedules, intake settings, holds, appointments, payment attempts, and encrypted Calendar connections.
- Admin identities, resource-scoped access, and administrative audit records.
- Training enrollments and paid scheduling eligibility.
- Marketing contacts, submissions, consent events, durable Resend sync jobs, and campaign history.
- Transactional customer-email outbox, retention, and redaction state.

Do not use this runbook for Sanity content/schema deployment or the legacy Strapi-to-Sanity migration script.

## Hard Rules

- Never run `npm run db:migrate` until `DATABASE_URL` is verified as the intended target.
- Run migrations against staging first, then smoke test before production.
- Do not use schema push for production. Use committed/generated SQL migration files only.
- Do not manually edit production database schema to fix a failed migration.
- Do not edit an applied migration file or its `drizzle.__drizzle_migrations`
  row. The migration runner verifies the required active lineage plus narrowly
  scoped, explicitly audited historical entries and hash variants. It stops on
  any other mismatch, unknown entry, duplicate timestamp, or required gap.
- Do not paste full connection strings, passwords, or secrets into tickets, docs, PRs, or chat.
- Do not run migration scripts just to inspect behavior.

The 2026-08-15 staging lineage audit confirmed this deployed history:

- The abandoned `admin-dashboard-app` lineage left exact journal entries at
  timestamps `1780454716621` and `1780520000000`. Migration `0018_grey_xorn`
  already reconciles the abandoned schema, so these journal entries are
  accepted as optional historical provenance and are not applied to clean
  databases.
- Staging applied an earlier `0016_bitter_yellow_claw` revision with hash
  `223b503a8609f1f3451550a6ce9c133b89fe501b206dd147731d36f295fc09f3`.
  Migration `0024_private_db_lineage_reconciliation` additively creates the two
  indexes omitted by that revision. The runner accepts this exact historical
  hash only while the local `0016` file retains its canonical committed hash.
- Migrations `0032_fat_roulette` through `0035_tricky_photon` are deployed and
  immutable. Staging's `0034` and `0035` hashes match their committed files.
  Quarantine and filtered-uniqueness changes must remain in later additive
  migrations, including `0041`, `0044`, and `0046`; do not move them backward
  into `0034` or `0035`.

Before any other environment rollout, inventory its complete migration journal.
If `0034` or `0035` is present, its hash must match the committed file exactly.
If the environment contains any historical row or hash not explicitly audited
in `src/lib/private-db/migration-lineage.ts`, stop and reconcile it additively.

## Commands

Run all commands from the repository root:

```bash
cd /Users/dardan/workspace/lash-her-frontend
```

Generate a migration after intentional schema changes:

```bash
npm run db:generate
```

Check a target database without writing to it:

```bash
npm run db:check -- --env-file <protected-env-file>
```

`npm run db:check` verifies the complete applied lineage, including hashes, required gaps, duplicate or unknown timestamps, accepted historical variants, and pending committed migrations. A query such as `select max(created_at)` is not sufficient because it cannot detect an edited migration, an unknown row, or a missing migration beneath the latest timestamp.

Apply migrations to the database pointed to by `DATABASE_URL`, after setting the target guard variables:

```bash
PRIVATE_DB_MIGRATION_TARGET=staging \
PRIVATE_DB_MIGRATION_HOST=<verified-host> \
npm run db:migrate
```

Load `DATABASE_URL` through an already-exported protected shell environment or an explicit, gitignored env file. `scripts/migrate-private-db.ts` and `drizzle.config.ts` use `dotenv/config`, whose default file is `.env`; they do not automatically load Next.js `.env.local`. When using a different file, select it explicitly:

```bash
DOTENV_CONFIG_PATH=<protected-env-file> \
PRIVATE_DB_MIGRATION_TARGET=staging \
PRIVATE_DB_MIGRATION_HOST=<verified-host> \
npm run db:migrate
```

Use `npm run db:check -- --env-file <protected-env-file>` for read-only inspection. Do not pass a full connection string with `--url` or paste it into command examples, shell history, tickets, docs, PRs, or chat.

## Environment Handling

`DATABASE_URL` is server-only and must never use a `NEXT_PUBLIC_` prefix. It is consumed by both:

- `drizzle.config.ts` for `npm run db:generate`.
- `scripts/migrate-private-db.ts` for `npm run db:migrate`.

The migration script refuses to run unless `PRIVATE_DB_MIGRATION_TARGET` is `local`, `staging`, or `production`, and `PRIVATE_DB_MIGRATION_HOST` exactly matches the parsed `DATABASE_URL` host. Production also requires `PRIVATE_DB_MIGRATION_CONFIRM=production` after backup/PITR and approval checks.

Use separate staging and production database URLs. For Neon, confirm the project, branch, and host label in the Neon dashboard before running migrations. A transaction-pooler URL is preferred for the serverless runtime, but the database client explicitly supports both pooled and direct PostgreSQL endpoints with different bounded pool sizes. Do not substitute an unverified `DATABASE_URL_UNPOOLED` value during a migration or deploy.

If pulling Vercel environment variables locally, remember that `vercel env pull .env.local --yes` replaces `.env.local`. Preserve any local-only overrides before pulling, then use `DOTENV_CONFIG_PATH=.env.local` for the migrator or `npm run db:check -- --env-file .env.local` for the read-only check. Sensitive Vercel variables can be unavailable to a local pull; verify required values without weakening their dashboard scope.

## Pre-Migration Checklist

Complete this before every staging or production migration:

- [ ] Repository is on the intended branch and contains the expected migration file.
- [ ] `git status --short` has been reviewed so unrelated local changes are understood.
- [ ] Migration file has been reviewed in `drizzle/`.
- [ ] `npm run db:check` has been run against the target; any pending migration or lineage problem is understood before applying changes.
- [ ] The target's complete migration journal has been inventoried when reconciliation is required; any applied `0034`/`0035` row matches the committed hash and any legacy entry is explicitly audited above.
- [ ] Target environment is identified: staging or production.
- [ ] `DATABASE_URL` host/project/branch is verified without exposing the secret.
- [ ] Production backup/PITR status is verified before any production run.
- [ ] Approver is assigned for production migrations.
- [ ] Staging migration has completed successfully before production.
- [ ] Post-migration smoke checks are ready.

For migrations that touch operational data, verify the changed SQL creates or alters only the intended tables, indexes, constraints, and enum values. The committed journal currently continues through `0075_clammy_william_stryker`; never infer a target's state from that filename alone. `npm run db:check` is authoritative for whether that database matches the selected checkout.

## Staging Procedure

1. Confirm the staging database identity in the provider dashboard.
2. Load staging `DATABASE_URL` through an explicit protected environment.
3. Run the read-only lineage check and stop on any lineage problem:

   ```bash
   npm run db:check -- --env-file <protected-staging-env-file>
   ```

4. Apply pending migrations:

   ```bash
   DOTENV_CONFIG_PATH=<protected-staging-env-file> \
   PRIVATE_DB_MIGRATION_TARGET=staging \
   PRIVATE_DB_MIGRATION_HOST=<verified-staging-host> \
   npm run db:migrate
   ```

5. Rerun `npm run db:check -- --env-file <protected-staging-env-file>` and record the result and timestamp.
6. Verify the new tables, enum values, constraints, or indexes exist in the staging database.
7. Run the relevant application checks. Database-backed tests require a separate, isolated, migrated database; never point `TEST_DATABASE_URL` at staging or production:

   ```bash
   npm run test:unit
   node --env-file=/absolute/path/to/protected-test.env \
     scripts/run-source-unit-tests.mjs --db-only
   npm run lint
   npm run build
   npx playwright test tests/contact.spec.ts tests/contact-popup-validation.spec.ts tests/booking.spec.ts --project=chromium
   ```

   The protected test env file must define `TEST_DATABASE_URL` for an isolated test database. Before the DB suite, migrate that same isolated database with `DATABASE_URL`, `PRIVATE_DB_MIGRATION_TARGET=local`, and an exact `PRIVATE_DB_MIGRATION_HOST`. `scripts/run-source-unit-tests.mjs` does not load dotenv itself, so `DOTENV_CONFIG_PATH` alone does not load `TEST_DATABASE_URL`; use Node's explicit `--env-file` as above or export the test environment first. When it is already exported, use `npm run test:unit:db`, or `npm run test:unit:all` for both unit suites.

8. Smoke test staging flows that write operational data:
    - General inquiry submission.
    - Training/contact form submission.
    - Contact popup/email-list submission.
    - Booking with marketing opt-in checked.
    - Booking with marketing opt-in unchecked.
    - Paid service booking direct `CHARGE_AND_STORE` capture for deposit, full payment, and custom partial payment where configured.
    - Paid service booking finalization through `/api/booking/payment/confirm`, plus historical hosted-checkout return/webhook reconciliation. Product and training checkout finalize from the Square webhook (`/api/webhooks/square`) and capture-reconciliation paths.
9. Confirm new submissions do not create new Sanity submission documents.

## Production Procedure

Production migration can proceed only after staging has passed.

1. Confirm production database identity in the provider dashboard.
2. Confirm production backup/PITR availability.
3. Confirm production approver sign-off.
4. Load production `DATABASE_URL` through an explicit protected environment.
5. Re-read the target host/project/branch before executing.
6. Run `npm run db:check -- --env-file <protected-production-env-file>` and stop on any lineage problem.
7. Run:

   ```bash
   DOTENV_CONFIG_PATH=<protected-production-env-file> \
   PRIVATE_DB_MIGRATION_TARGET=production \
   PRIVATE_DB_MIGRATION_HOST=<verified-production-host> \
   PRIVATE_DB_MIGRATION_CONFIRM=production \
   npm run db:migrate
   ```

8. Rerun `npm run db:check -- --env-file <protected-production-env-file>` and record evidence immediately.
9. Run production-safe smoke checks with approved test data only. Run DB-backed automated tests against an isolated migrated test database, never production.
10. Monitor Vercel logs for write failures from form actions, booking creation, checkout routes, scheduled workers, and webhook finalizers.

## Sanity Submission Backfill

After `drizzle/0002_rapid_fat_cobra.sql` has been applied, existing Sanity submission documents can be copied into the private database. This is separate from the schema migration and must run only after the private tables exist.

Dry-run first:

```bash
./node_modules/.bin/tsx --conditions=react-server scripts/backfill-marketing-contact-submissions.ts
```

Execute only after the dry-run counts look correct and `DATABASE_URL` targets the intended private database:

```bash
./node_modules/.bin/tsx --conditions=react-server scripts/backfill-marketing-contact-submissions.ts --execute
```

The backfill script reads Sanity documents of type `generalInquiry`, `contactForm`, `contactPopupSubmission`, and `bookingMarketingOptIn`. Existing `generalInquiry` and `contactForm` records become private `marketing_contact_submissions` plus `marketing_consent_events` with `no_opt_in`; they are not inserted into `marketing_contacts` because those historical forms did not capture affirmative marketing consent.

The script records original Sanity document IDs in `source_document_id` and uses `source_system = 'sanity'` so repeated runs can avoid duplicating imported Sanity source rows.

## Evidence Template

Copy this table into the release notes or launch checklist for each migration run.

| Field | Value |
| --- | --- |
| Environment | Staging / Production |
| Provider | |
| Host/Dashboard Label | |
| Branch/Project/DB ID | |
| Migration File(s) | |
| Backup/PITR Status | Verified / Not applicable / Blocked |
| Operator | |
| Verifier | |
| Approver | |
| Command Run | `npm run db:migrate` |
| Pre/Post `db:check` Result | |
| Timestamp | |
| Result | Success / Failure |
| Post-Migration Smoke Result | |
| Rollback/Roll-forward Notes | |

Do not include passwords, complete connection strings, customer PII, payment tokens, or raw submission payloads in evidence.

## Stop Conditions

Stop immediately if any of these occur:

- `DATABASE_URL` cannot be verified as the intended target.
- `npm run db:check` reports an unknown entry, hash mismatch, duplicate timestamp, required gap, or unexpected pending migration.
- Production backup/PITR cannot be verified.
- Approver sign-off is missing for production.
- `npm run db:migrate` exits non-zero.
- The database becomes unreachable after migration.
- Staging smoke tests fail.
- New customer PII appears in Sanity as part of a migrated flow.

## Failure Handling

If a migration fails:

1. Stop all further migration attempts.
2. Capture the migration file name, environment, timestamp, and sanitized error output.
3. Do not manually edit production schema.
4. If production data integrity is at risk, restore from backup/PITR according to provider guidance.
5. If the issue is a code/schema defect, create a new migration and roll forward in staging first.
6. Re-run production only after staging passes and approval is renewed.

## Related Documents

- `docs/marketing-contact-privacy-compliance-follow-up.md`
- `docs/launch-readiness-checklist.md`
- `AGENTS.md`
- `README.md`
