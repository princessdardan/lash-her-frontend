# Private Database Migration Runbook

This runbook describes how to safely verify, run, and record private PostgreSQL migrations for Lash Her. The private database stores checkout/order records, appointment hold/payment lifecycle records, and marketing/contact submission records. Sanity remains the public editorial CMS and historical submission backfill source; new private data must not be written to Sanity.

Use this runbook for generated Drizzle migrations in `drizzle/`.

## Scope

Private database migrations cover tables defined in `src/lib/private-db/schema.ts` and applied by `scripts/migrate-private-db.ts`.

Current private DB domains include:

- Checkout orders and payment events.
- Appointment holds and paid booking finalization state.
- Training enrollments.
- Marketing contacts, contact submissions, and consent events.

Do not use this runbook for Sanity content/schema deployment or the legacy Strapi-to-Sanity migration script.

## Hard Rules

- Never run `npm run db:migrate` until `DATABASE_URL` is verified as the intended target.
- Run migrations against staging first, then smoke test before production.
- Do not use schema push for production. Use committed/generated SQL migration files only.
- Do not manually edit production database schema to fix a failed migration.
- Do not paste full connection strings, passwords, or secrets into tickets, docs, PRs, or chat.
- Do not run migration scripts just to inspect behavior.

## Commands

Run all commands from the repository root:

```bash
cd /Users/dardan/workspace/lash-her-frontend
```

Generate a migration after intentional schema changes:

```bash
npm run db:generate
```

Apply migrations to the database pointed to by `DATABASE_URL`, after setting the target guard variables:

```bash
PRIVATE_DB_MIGRATION_TARGET=staging \
PRIVATE_DB_MIGRATION_HOST=<verified-host> \
npm run db:migrate
```

If `DATABASE_URL` is not already loaded, load it through a local `.env.local`, Vercel environment pull, or a protected shell session before running the command. Do not paste full connection strings into command examples, shell history, tickets, docs, PRs, or chat.

## Environment Handling

`DATABASE_URL` is server-only and must never use a `NEXT_PUBLIC_` prefix. It is loaded by both:

- `drizzle.config.ts` for `npm run db:generate`.
- `scripts/migrate-private-db.ts` for `npm run db:migrate`.

The migration script refuses to run unless `PRIVATE_DB_MIGRATION_TARGET` is `local`, `staging`, or `production`, and `PRIVATE_DB_MIGRATION_HOST` exactly matches the parsed `DATABASE_URL` host. Production also requires `PRIVATE_DB_MIGRATION_CONFIRM=production` after backup/PITR and approval checks.

Use separate staging and production database URLs. For Neon, confirm the project, branch, and host label in the Neon dashboard before running migrations. The checkout runtime expects the pooled `DATABASE_URL`; do not switch runtime code to `DATABASE_URL_UNPOOLED`.

If pulling Vercel environment variables locally, remember that `vercel env pull .env.local --yes` replaces `.env.local`. Preserve any local-only overrides before pulling.

## Pre-Migration Checklist

Complete this before every staging or production migration:

- [ ] Repository is on the intended branch and contains the expected migration file.
- [ ] `git status --short` has been reviewed so unrelated local changes are understood.
- [ ] Migration file has been reviewed in `drizzle/`.
- [ ] Target environment is identified: staging or production.
- [ ] `DATABASE_URL` host/project/branch is verified without exposing the secret.
- [ ] Production backup/PITR status is verified before any production run.
- [ ] Approver is assigned for production migrations.
- [ ] Staging migration has completed successfully before production.
- [ ] Post-migration smoke checks are ready.

For migrations that touch private operational data, verify the changed SQL creates or alters only the intended tables and enum values. Current private domains include `checkout_orders`, `checkout_payment_events`, `training_enrollments`, `appointment_holds`, `marketing_contacts`, `marketing_contact_submissions`, and `marketing_consent_events`.

## Staging Procedure

1. Confirm the staging database identity in the provider dashboard.
2. Load staging `DATABASE_URL` locally or in the migration environment.
3. Run:

   ```bash
   PRIVATE_DB_MIGRATION_TARGET=staging \
   PRIVATE_DB_MIGRATION_HOST=<verified-staging-host> \
   npm run db:migrate
   ```

4. Record the command result and timestamp.
5. Verify the new tables, enum values, or indexes exist in the staging database.
6. Run the relevant application checks:

   ```bash
   npm run test:unit
   npm run lint
   npm run build
   npx playwright test tests/contact.spec.ts tests/contact-popup-validation.spec.ts tests/booking.spec.ts --project=chromium
   ```

7. Smoke test staging flows that write private data:
    - General inquiry submission.
    - Training/contact form submission.
    - Contact popup/email-list submission.
    - Booking with marketing opt-in checked.
    - Booking with marketing opt-in unchecked.
    - Paid service booking checkout for deposit, full payment, and custom partial payment where configured.
    - Paid service booking finalization from Square return reconciliation and webhook retry paths; product/training checkout remains on Helcim validation and webhook paths.
8. Confirm new submissions do not create new Sanity submission documents.

## Production Procedure

Production migration can proceed only after staging has passed.

1. Confirm production database identity in the provider dashboard.
2. Confirm production backup/PITR availability.
3. Confirm production approver sign-off.
4. Load production `DATABASE_URL` locally or in the migration environment.
5. Re-read the target host/project/branch before executing.
6. Run:

   ```bash
   PRIVATE_DB_MIGRATION_TARGET=production \
   PRIVATE_DB_MIGRATION_HOST=<verified-production-host> \
   PRIVATE_DB_MIGRATION_CONFIRM=production \
   npm run db:migrate
   ```

7. Record evidence immediately.
8. Run production-safe smoke checks with test data only.
9. Monitor Vercel logs for write failures from form actions, booking creation, and checkout routes.

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
| Timestamp | |
| Result | Success / Failure |
| Post-Migration Smoke Result | |
| Rollback/Roll-forward Notes | |

Do not include passwords, complete connection strings, customer PII, payment tokens, or raw submission payloads in evidence.

## Stop Conditions

Stop immediately if any of these occur:

- `DATABASE_URL` cannot be verified as the intended target.
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
