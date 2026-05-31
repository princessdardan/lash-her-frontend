# Production Cutover and Migration Plan

Date: 2026-05-26

## Purpose

This document tracks the production-only migration work that was intentionally separated from `docs/production-readiness-audit.md`.

The readiness audit now evaluates whether the codebase is launch-ready when it is run against the approved staging Sanity dataset and schemas. This migration plan covers the later cutover where the current staging codebase replaces production and the staging Sanity dataset is promoted into the production Sanity dataset.

## Findings moved from the readiness audit

| Audit item | Why it moved here | Migration outcome required |
| --- | --- | --- |
| B3. Production environment validation fails in local production simulation | This is a production Vercel configuration/cutover check, not evidence that the staging-backed codebase is unfit. | Production Vercel env vars pass `VERCEL_ENV=production node scripts/validate-sanity-env.mjs` before production deployment. |
| C2. Production deployed Sanity schema/content is behind source and staging | The planned release replaces production with staging/source, so current production drift is the migration target rather than a codebase-readiness defect. | Production schema and content are intentionally replaced or promoted from the approved staging source of truth. |
| M1. `sanity.cli.ts` defaults unqualified Sanity CLI operations to production | This is a cutover/operator guardrail for schema and dataset commands. | Production/staging Sanity commands are run with explicit target env vars or wrapper scripts so the target dataset is visible. |
| Production portions of C1. Legacy submission documents exist in public Sanity datasets | Historical production/staging Sanity submission cleanup is a data migration/privacy step. The source/schema privacy boundary remains a readiness finding. | Legacy submission records are backfilled/verified privately, then redacted, deleted, or excluded before production import. |
| Production gates in the old launch checklist | Those gates verify the target production deployment after the codebase is already ready. | Complete the cutover checklist below before replacing production. |

## Preconditions

- The revised production readiness audit has no remaining codebase blockers.
- Staging app, Studio, and `staging-2026-05-10` content are approved as the source of truth.
- Production content is frozen for the migration window.
- Nataliea or the named launch approver has approved the cutover window and rollback plan.
- No secrets, raw customer PII, full database URLs, payment tokens, or raw webhook payloads are pasted into evidence.

## Phase 1: Freeze, inventory, and backup

1. Announce a production content freeze.
2. Record the exact Git commit/branch that will replace production.
3. Confirm the Sanity project is `3auncj84`.
4. Confirm the staging dataset is `staging-2026-05-10` and production dataset is `production`.
5. Export the current production dataset as a rollback/forensics backup before any import:

   ```bash
   npx sanity dataset export production ./production-pre-cutover-backup.tar.gz --project-id 3auncj84
   ```

6. Confirm private database backups/PITR are available for the production `DATABASE_URL` target before any database migration.

## Phase 2: Sanity privacy cleanup before export/import

Do not promote private submission documents into production as part of the staging dataset import.

1. Backfill or verify private database records for legacy Sanity submission types where needed:
   - `contactForm`
   - `generalInquiry`
   - `contactPopupSubmission`
   - `bookingMarketingOptIn`
2. Use `docs/private-database-migration-runbook.md` and `docs/marketing-contact-privacy-compliance-follow-up.md` for the backfill, retention, and redaction checkpoints.
3. Decide and record the approved disposition for legacy Sanity submission records: delete, redact, archive outside live Studio workflows, or exclude from the production import.
4. Verify the staging dataset that will be exported does not contain customer PII or live/private submission documents.
5. Verify the Studio sidebar and structure no longer expose live private submission workflows, or that any archival type is formally access-controlled and read-only.

Stop if customer PII or payment-adjacent records would be imported into a public Sanity dataset without an approved privacy disposition.

## Phase 3: Sanity schema and CLI targeting guardrails

1. Prefer explicit environment variables for every Sanity command:

   ```bash
   NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84 \
   NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10 \
   NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24 \
   npx sanity schema deploy
   ```

   ```bash
   NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84 \
   NEXT_PUBLIC_SANITY_DATASET=production \
   NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24 \
   npx sanity schema deploy
   ```

2. Before heavy promotion work, consider changing `sanity.cli.ts` or adding wrapper scripts so unqualified CLI operations cannot silently target production when the operator meant staging.
3. Remember that dataset import does not deploy schema code, and schema deploy does not migrate existing content.

## Phase 4: Production Vercel environment migration

Production deployment must use production-scoped values, even when the content originates from staging.

Minimum checks:

- `NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84`
- `NEXT_PUBLIC_SANITY_DATASET=production`
- `NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24`
- `SANITY_WEBHOOK_SECRET` matches the production Sanity webhook secret.
- `DATABASE_URL` targets the verified production private database.
- `KV_REST_API_URL` and `KV_REST_API_TOKEN` target the intended production Redis/KV resource.
- `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_SEGMENT_MARKETING_ID`, `FROM_EMAIL`, and `ADMIN_EMAIL` are production-approved.
- Google OAuth variables use production callback URLs.
- `PAYMENT_GATEWAY_MODE` is not `mock` in production.
- Helcim production tokens and webhook verifier are present.
- If Square service booking is enabled, Square production environment, access token, location, webhook signature key, return URL, and webhook URL all point to the same production Square application.

Validation command after loading production-scoped variables safely:

```bash
VERCEL_ENV=production node scripts/validate-sanity-env.mjs
```

Do not record secret values in launch evidence. Record only presence, scope, owner/verifier, and sanitized validation output.

## Phase 5: Promote staging Sanity content into production

If staging is the complete approved source of truth, use the full import path only after Phase 2 privacy cleanup is complete:

```bash
npx sanity dataset export staging-2026-05-10 ./staging-approved-cutover.tar.gz \
  --project-id 3auncj84 \
  --overwrite

npx sanity dataset import ./staging-approved-cutover.tar.gz production \
  --project-id 3auncj84 \
  --replace
```

If only public/editorial launch content should replace production, use selected type export/import instead of a full dataset import. At minimum, include the public types the app renders: `homePage`, `contactPage`, `galleryPage`, `globalSettings`, `mainMenu`, `trainingProgramsPage`, `trainingProgram`, `product`, `service`, `bookingSettings`, and any approved public block/page types used by those documents.

## Phase 6: Deploy production app and Sanity schema

1. Merge and deploy the approved codebase to production.
2. Confirm production Vercel uses `NEXT_PUBLIC_SANITY_DATASET=production`.
3. Deploy the production schema from source.
4. Load `/studio` on the production domain and verify the Studio targets the `production` dataset.
5. Verify singleton documents and Studio structure match the approved staging Studio.

## Phase 7: Configure and verify production Sanity webhooks

Configure a production Sanity webhook for the `production` dataset:

| Setting | Production value |
| --- | --- |
| URL | `https://<production-domain>/api/revalidate` |
| Project | `3auncj84` |
| Dataset | `production` |
| Trigger | Published document create, update, and delete events |
| Projection | `{ _type }` |
| Method | `POST` |
| Secret | Production `SANITY_WEBHOOK_SECRET` |

Use the current cache-tag map in `src/app/api/revalidate/route.ts` as the source of truth for the filter. Update docs that still reference stale public types before relying on webhook smoke evidence.

Smoke test:

1. Publish a safe visible edit in production Studio.
2. Confirm Sanity reports a successful webhook delivery.
3. Confirm Vercel logs show the expected revalidation tag.
4. Confirm the mapped production page updates.
5. Revert the smoke edit if it was test-only.

## Phase 8: Production smoke and evidence

Run the public smoke matrix against production after import and deployment:

- `/`
- `/contact`
- `/gallery`
- `/products`
- `/products/[slug]`
- `/services`
- `/services/[slug]`
- `/booking`
- `/training-programs`
- `/training-programs/[slug]`

Run production-safe private-flow smoke checks with approved test data only:

- Product checkout handoff and Helcim webhook path.
- Training checkout handoff and Helcim webhook path.
- Service booking hold, Square checkout return/webhook reconciliation, and Calendar finalization where Square booking is enabled.
- General inquiry, training inquiry, contact popup, and booking marketing opt-in/no-opt-in flows writing to private DB only.
- No new Sanity documents of legacy private submission types are created.

## Stop conditions

- Production env validation fails.
- Production dataset cannot be backed up before import.
- Staging export contains private submission documents without approved disposition.
- Production import targets the wrong dataset.
- Production Studio targets anything other than `production` after deployment.
- Signed production webhook delivery fails or revalidates the wrong cache tag.
- Product, training, service booking, contact, or inquiry smoke tests write private data to Sanity.
- Production payment or private database credentials cannot be matched to the intended production providers.

## Evidence template

| Field | Value |
| --- | --- |
| Approved Git commit | |
| Staging dataset export file | |
| Production backup file | |
| Production env validation result | |
| Production schema deploy result | |
| Production dataset import result | |
| Production webhook smoke result | |
| Public page smoke result | |
| Private-flow smoke result | |
| PII/Sanity submission cleanup result | |
| Operator | |
| Verifier | |
| Approval | |

## Related documents

- `docs/production-readiness-audit.md`
- `docs/sanity-staging-production-workflow.md`
- `docs/private-database-migration-runbook.md`
- `docs/marketing-contact-privacy-compliance-follow-up.md`
- `docs/launch-readiness-checklist.md`
