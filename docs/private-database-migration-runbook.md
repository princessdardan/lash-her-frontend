# Private Database Migration Runbook

PostgreSQL owns operational booking/catalog configuration and private commerce, admin, training, marketing and consent records. Sanity owns public editorial content. Migrations are committed forward SQL in `drizzle/`.

## Release migrations

Staging and production use the [single-operator release policy](api-integration/release-policy.md) and [frontend operator component](api-integration/operator-frontend-migrations.md). Dardan's explicit release action is approval. No second reviewer, signing service or separately hosted executor is required. The component is locally verified; frontend deployment/promotion and final traffic admission remain to be connected. A successful database receipt alone cannot authorize traffic.

Select exact passing source/CI and SQL/schema digests, verify the dedicated provider/project/branch and direct TLS target, review pending SQL, suspend affected producers, and retain one environment lock through migration and deployment. Production additionally requires the same source/SQL already verified in staging and a current usable recovery point. The runner verifies the complete journal on one locked database session, applies the reviewed chain, checks schema/runtime grants, and retains database and terminal outcomes in the ordinary release evidence.

Do not use direct Drizzle Kit writes, seeds, tests, application startup or the retired protected staging job against a release target. `npm run db:migrate` now refuses staging, production and remote hosts even if labelled local. Do not change that guard to perform a release.

## Inspect and develop

Run Node24 from the repository root. Generate intentional schema changes with `npm run db:generate`. Inspect any verified target without writing:

```sh
npm run db:check -- --env-file <protected-env-file>
```

A pending-only nonzero result must match the reviewed migration range. Unknown hashes, required gaps, duplicate timestamps and unaudited historical entries stop rollout. Read the complete journal; a maximum timestamp is insufficient. Keep full connection strings out of arguments, logs and chat.

For an isolated disposable local database only:

```sh
DOTENV_CONFIG_PATH=<protected-local-env-file> \
PRIVATE_DB_MIGRATION_TARGET=local \
PRIVATE_DB_MIGRATION_HOST=127.0.0.1 \
npm run db:migrate
```

The protected file selects the matching loopback `DATABASE_URL`; the local script loads dotenv explicitly. The operator release component does not load dotenv or fall back to `DATABASE_URL`. Runtime and migration credentials remain separate. Never point `TEST_DATABASE_URL` at staging or production. Run the relevant source/database/browser checks on isolated fixtures, then perform environment-safe application smoke checks during the release.

## Historical lineage

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

## Evidence and failures

Use the ordinary release receipt: operator, environment, source/SQL/schema identities, verified target, recovery reference, complete pre/post lineage, applied migrations and smoke results. Retain both the database receipt written under lock and the terminal outcome after cleanup. No additional approver/verifier ledger is needed for a single operator. Exclude passwords, URLs, customer PII and payment tokens.

On failure, stop rollout and further automatic attempts. Keep affected writes suspended, inspect the actual journal and sanitized outcome, and reconcile committed state before a deliberate retry. Preserve applied SQL and journal rows. Use a reviewed new forward migration for defects; database restoration requires an incident recovery/reconciliation plan, not a routine down migration. Repeat production only after the corrected candidate passes staging and Dardan explicitly selects production again.
