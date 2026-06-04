# Production Cutover Checklist

Purpose: guide launch-day cutover from approved staging to production for the Lash Her Next.js app, Sanity content lake, private PostgreSQL database, and connected providers.

This runbook assumes option A is approved: the frozen `staging-2026-05-10` Sanity dataset is the complete source of truth and will fully replace the `production` dataset in Sanity project `3auncj84`.

## Assumptions

- Commands run from the repository root: `/Users/dardan/workspace/lash-her-frontend`.
- Production content edits are frozen until cutover is complete or rolled back.
- Staging smoke evidence is approved and `staging-2026-05-10` contains only production-safe public/editorial content.
- Production private data stays in PostgreSQL. Sanity stores public/editorial content only.
- Direct booking creation remains disabled; appointment confirmation happens only after secure payment reconciliation.
- Product and training checkout use Helcim. Paid service booking uses Square only when `SERVICE_BOOKING_SQUARE_ENABLED=true`.

## Hard Rules

- Do not record secrets, customer PII, payment IDs, raw webhook payloads, raw form payloads, or full database connection strings in evidence.
- Do not import private submission documents or payment-adjacent data into Sanity.
- Do not use `PAYMENT_GATEWAY_MODE=mock` in production.
- Do not run production Sanity schema operations unless `SANITY_SCHEMA_DEPLOY_TARGET=production` is set.
- Do not run production private DB migrations unless the production DB identity, backup/PITR, and migration approval are verified.
- Do not paste the Google OAuth setup URL (`/api/booking/oauth/start?secret=<BOOKING_ADMIN_SETUP_SECRET>`) in tickets, chat, or evidence.

## Roles and Evidence Template

| Field | Value |
| --- | --- |
| Launch window | |
| Approved Git branch/commit | |
| Staging dataset source | `staging-2026-05-10` |
| Production dataset target | `production` |
| Production DB provider/host label | |
| Production backup/PITR status | |
| Operator | |
| Verifier | |
| Business approver | |
| Production backup file | |
| Staging export file | |
| DB migration result | |
| Schema deploy result | |
| App deploy result | |
| Webhook smoke result | |
| Public page smoke result | |
| Private-flow smoke result | |
| Rollback/failure notes | |

Evidence may include sanitized timestamps, command names, dashboard labels, redacted transaction references, Resend message IDs, webhook delivery statuses, Vercel log references, and redacted query results.

## Stop Conditions

Stop immediately if any condition is true:

- Launch approval, content freeze, or rollback owner is missing.
- `git status` or branch/commit does not match the approved release.
- `staging-2026-05-10` is not frozen or contains unapproved/private records.
- Production DB identity cannot be verified, production backup/PITR is unavailable, or private DB migrations are missing/unapplied.
- Any production env var points to staging/dev when it must point to production.
- `VERCEL_ENV=production node scripts/validate-sanity-env.mjs` fails.
- Sanity backup/export/import targets the wrong project or dataset.
- Production Studio targets anything other than `production`.
- Sanity revalidation, Helcim, Square, Resend, Google Calendar, Upstash, or private DB smoke tests fail.
- Any live flow writes new private submission, checkout, payment, booking hold, or enrollment data to Sanity.

## Phase 0: Launch Window, Repo, and Content Freeze

- [ ] Confirm launch window, operator, verifier, approver, rollback owner, and communication channel.
- [ ] Announce production content freeze.
- [ ] Confirm canonical repo remote if any push/deploy work is needed.
- [ ] Record approved branch and commit.
- [ ] Confirm no unreviewed local changes are involved.

```bash
cd /Users/dardan/workspace/lash-her-frontend
git remote -v
git status --short
git branch --show-current
git rev-parse HEAD
```

## Phase 1: Staging Source-of-Truth Verification and Smoke Evidence

- [ ] Confirm Sanity project `3auncj84` has both `staging-2026-05-10` and `production` datasets.
- [ ] Confirm staging Studio and app target `staging-2026-05-10`.
- [ ] Confirm staging public/editorial content is approved as the complete production source of truth.
- [ ] Record staging smoke evidence from `docs/launch-readiness-checklist.md`.
- [ ] Verify no new Sanity private submission documents are created by staging forms, checkout, or booking flows.

```bash
NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10 \
npx sanity dataset list --project-id 3auncj84
VERCEL_ENV=preview NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10 node scripts/validate-sanity-env.mjs
```

## Phase 2: Production Environment Variables and Secrets Inventory

Verify production-scoped values in Vercel/provider dashboards. Record presence, scope, owner, and sanitized validation output only.

### Sanity

- [ ] `NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84`
- [ ] `NEXT_PUBLIC_SANITY_DATASET=production`
- [ ] `NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24`
- [ ] `SANITY_API_READ_TOKEN`
- [ ] `SANITY_WRITE_TOKEN`
- [ ] `SANITY_WEBHOOK_SECRET`

### Resend

- [ ] `RESEND_API_KEY`
- [ ] `RESEND_WEBHOOK_SECRET`
- [ ] `RESEND_SEGMENT_MARKETING_ID`
- [ ] `FROM_EMAIL`
- [ ] `ADMIN_EMAIL`
- [ ] Optional source segments intentionally configured only where used: `RESEND_SEGMENT_BOOKING_ID`, `RESEND_SEGMENT_CONTACT_POPUP_ID`, `RESEND_SEGMENT_GENERAL_INQUIRY_ID`, `RESEND_SEGMENT_SANITY_BACKFILL_ID`, `RESEND_SEGMENT_TRAINING_CONTACT_ID`.
- [ ] Optional topic preferences intentionally configured only where used: `RESEND_TOPIC_MARKETING_ID`, `RESEND_TOPIC_NEWSLETTER_ID`, `RESEND_TOPIC_TRAINING_ID`.
- [ ] Optional dashboard templates intentionally configured only where used: `RESEND_TEMPLATE_BOOKING_CONFIRMATION_ID`, `RESEND_TEMPLATE_CONTACT_POPUP_ADMIN_ID`, `RESEND_TEMPLATE_CONTACT_POPUP_CUSTOMER_ID`, `RESEND_TEMPLATE_GENERAL_INQUIRY_ADMIN_ID`, `RESEND_TEMPLATE_GENERAL_INQUIRY_CUSTOMER_ID`, `RESEND_TEMPLATE_PRODUCT_CONFIRMATION_ID`, `RESEND_TEMPLATE_TRAINING_CONTACT_ADMIN_ID`, `RESEND_TEMPLATE_TRAINING_CONTACT_CUSTOMER_ID`, `RESEND_TEMPLATE_TRAINING_PAYMENT_ADMIN_ID`, `RESEND_TEMPLATE_TRAINING_PAYMENT_CUSTOMER_ID`.
- [ ] Optional automation event name intentionally configured only if overriding the default: `RESEND_EVENT_MARKETING_CONTACT_OPTED_IN`.
- [ ] `EMAIL_PROFILE_IMAGE_URL` if used.
- [ ] `EMAIL_RETRY_SECRET`
- [ ] `CRON_SECRET`

### Google Calendar Booking

- [ ] `GOOGLE_CLIENT_ID`
- [ ] `GOOGLE_CLIENT_SECRET`
- [ ] `GOOGLE_REDIRECT_URI` points to the production callback URL.
- [ ] `BOOKING_ADMIN_SETUP_SECRET`

### Upstash Redis / KV

- [ ] `KV_REST_API_URL`
- [ ] `KV_REST_API_TOKEN`

### Private Database

- [ ] `DATABASE_URL` targets the verified production private DB.
- [ ] `PRIVATE_DB_MIGRATION_TARGET=production` for migration command only.
- [ ] `PRIVATE_DB_MIGRATION_HOST=<verified-production-host>` for migration command only.
- [ ] `PRIVATE_DB_MIGRATION_CONFIRM=production` for migration command only.

### Payment Runtime

- [ ] `PAYMENT_GATEWAY_MODE=live`
- [ ] `PAYMENT_MOCK_DEFAULT_SCENARIO` is dev-only and not relied on in production.
- [ ] `SERVICE_BOOKING_SQUARE_ENABLED` matches launch decision.

### Helcim

- [ ] `HELCIM_GENERAL_API_TOKEN`
- [ ] `HELCIM_TRANSACTION_API_TOKEN`
- [ ] `CHECKOUT_SECRET_ENCRYPTION_KEY`
- [ ] `HELCIM_WEBHOOK_VERIFIER_TOKEN`

### Square

- [ ] `SQUARE_ENVIRONMENT=production` if Square service booking is enabled.
- [ ] `SQUARE_ACCESS_TOKEN`
- [ ] `SQUARE_LOCATION_ID`
- [ ] `SQUARE_WEBHOOK_SIGNATURE_KEY`
- [ ] `SQUARE_SERVICE_BOOKING_RETURN_URL=https://<production-domain>/api/booking/square/return`
- [ ] `SQUARE_SERVICE_BOOKING_WEBHOOK_URL=https://<production-domain>/api/webhooks/square`
- [ ] Optional `SERVICE_BOOKING_HELCIM_LEGACY_CUTOFF_AT` only if intentionally used.
- [ ] Optional `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED` only if intentionally used.

## Phase 3: Production Private Database Readiness and Migrations

Use `docs/private-database-migration-runbook.md` as the detailed source of truth.

- [ ] Verify production DB identity in the provider dashboard: project, branch, database name, and host label.
- [ ] Verify production backup/PITR availability before any migration.
- [ ] Review committed migration files in `drizzle/` and confirm expected files are present.
- [ ] Confirm staging already ran the same migration set successfully.
- [ ] Confirm production `DATABASE_URL` host matches `<verified-production-host>` without exposing the full URL.
- [ ] Apply needed migrations only with the production guard variables.
- [ ] Record sanitized command result, timestamp, migration files, operator, verifier, and backup/PITR status.
- [ ] Stop if migrations are missing, unapplied, fail, or DB identity cannot be verified.

```bash
cd /Users/dardan/workspace/lash-her-frontend
ls drizzle
```

```bash
PRIVATE_DB_MIGRATION_TARGET=production \
PRIVATE_DB_MIGRATION_HOST=<verified-production-host> \
PRIVATE_DB_MIGRATION_CONFIRM=production \
npm run db:migrate
```

## Phase 4: Production Provider Dashboard Setup

- [ ] Helcim production API access is active for product and training checkout.
- [ ] Helcim webhook delivery URL is `https://<production-domain>/api/webhooks/card-transactions` and does **not** contain `helcim`.
- [ ] Square production app/location is configured only for paid service booking when enabled.
- [ ] Square webhook URL is `https://<production-domain>/api/webhooks/square`.
- [ ] Square return URL is `https://<production-domain>/api/booking/square/return`.
- [ ] Google OAuth consent/client has the production redirect URI.
- [ ] Upstash production Redis/KV instance is reachable and separate from staging/dev where required.
- [ ] Resend domain, sender, webhook secret, marketing segment, optional topics/templates, and suppression/unsubscribe handling are production-ready.

## Phase 5: Sanity Backup and Full Staging Replacement of Production

`sanity dataset import --replace` alone is **not** a full dataset replacement. It replaces documents with matching IDs, but it can leave production-only documents behind when those IDs are absent from staging. For launch day, the approved destructive replacement path is to back up production, delete and recreate an empty `production` dataset with the intended visibility, then import the frozen staging export.

- [ ] Back up current production before any destructive action.
- [ ] Export frozen staging.
- [ ] Record the current `production` dataset visibility (`public` or `private`) and the intended recreated visibility.
- [ ] Verify both `./production-pre-cutover-backup.tar.gz` and `./staging-approved-cutover.tar.gz` exist and are the expected files before deleting anything.
- [ ] Perform privacy cleanup/check before export/import: staging must not contain private/PII submission documents, payment records, checkout tokens, booking holds, enrollment state, Square IDs, Helcim IDs, or raw payloads.
- [ ] Stop if `contactForm`, `generalInquiry`, `contactPopupSubmission`, `bookingMarketingOptIn`, or any private/payment-adjacent records would be promoted without approved disposition.
- [ ] Delete the `production` dataset only after explicit approval and backup/export verification.
- [ ] Recreate `production` with the recorded intended visibility.
- [ ] Import `./staging-approved-cutover.tar.gz` into the newly recreated empty `production` dataset.
- [ ] Reconfigure or verify production Sanity webhooks and CORS afterward if needed.
- [ ] Warn Phase 6 owner that dataset recreation removes dataset content state; the source-controlled production schema must be redeployed or verified after recreation.
- [ ] Post-import verification: compare staging and production document totals, types, and ID lists closely enough to catch orphan production documents.
- [ ] Record filenames, timestamps, sanitized command results, operator, verifier, approval, visibility, and post-import verification evidence.

```bash
cd /Users/dardan/workspace/lash-her-frontend

NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10 \
npx sanity dataset list --project-id 3auncj84

NEXT_PUBLIC_SANITY_DATASET=production \
SANITY_SCHEMA_DEPLOY_TARGET=production \
npx sanity dataset export production ./production-pre-cutover-backup.tar.gz \
  --project-id 3auncj84 \
  --overwrite
```

```bash
NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10 \
npx sanity dataset export staging-2026-05-10 ./staging-approved-cutover.tar.gz \
  --project-id 3auncj84 \
  --overwrite
```

```bash
ls -lh ./production-pre-cutover-backup.tar.gz ./staging-approved-cutover.tar.gz
```

After explicit approval and backup/export verification:

```bash
NEXT_PUBLIC_SANITY_DATASET=production \
SANITY_SCHEMA_DEPLOY_TARGET=production \
npx sanity dataset delete production --project-id 3auncj84

NEXT_PUBLIC_SANITY_DATASET=production \
SANITY_SCHEMA_DEPLOY_TARGET=production \
npx sanity dataset create production \
  --project-id 3auncj84 \
  --visibility <recorded-public-or-private>

NEXT_PUBLIC_SANITY_DATASET=production \
SANITY_SCHEMA_DEPLOY_TARGET=production \
npx sanity dataset import ./staging-approved-cutover.tar.gz production \
  --project-id 3auncj84
```

Verification support examples (not the only approval gate):

```bash
NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10 \
npx sanity documents query 'count(*[])' \
  --project-id 3auncj84 \
  --dataset staging-2026-05-10

NEXT_PUBLIC_SANITY_DATASET=production \
SANITY_SCHEMA_DEPLOY_TARGET=production \
npx sanity documents query 'count(*[])' \
  --project-id 3auncj84 \
  --dataset production

NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10 \
npx sanity documents query '*[] | order(_type asc, _id asc){_id,_type}' \
  --project-id 3auncj84 \
  --dataset staging-2026-05-10 > /tmp/staging-cutover-documents.json

NEXT_PUBLIC_SANITY_DATASET=production \
SANITY_SCHEMA_DEPLOY_TARGET=production \
npx sanity documents query '*[] | order(_type asc, _id asc){_id,_type}' \
  --project-id 3auncj84 \
  --dataset production > /tmp/production-cutover-documents.json

diff -u /tmp/staging-cutover-documents.json /tmp/production-cutover-documents.json
```

## Phase 6: Production App/Schema Deploy and Vercel Env Validation

- [ ] Validate production env targeting before deployment.
- [ ] Deploy production app through the approved Vercel/Git path.
- [ ] Deploy source-controlled Sanity schema to `production` with the production guard.
- [ ] Open production `/studio` and verify the Studio targets `production`.

```bash
cd /Users/dardan/workspace/lash-her-frontend
VERCEL_ENV=production NEXT_PUBLIC_SANITY_DATASET=production node scripts/validate-sanity-env.mjs
```

```bash
NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84 \
NEXT_PUBLIC_SANITY_DATASET=production \
NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24 \
SANITY_SCHEMA_DEPLOY_TARGET=production \
npx sanity schema deploy --workspace default
```

## Phase 7: Google Calendar OAuth Connection and `bookingSettings`

- [ ] Run the one-time production OAuth connection only from a secure operator session.
- [ ] Do not paste the setup URL or secret in evidence.
- [ ] Verify OAuth token storage/refresh works through Upstash.
- [ ] Verify production `bookingSettings` exists in Sanity and contains approved service booking settings.
- [ ] Verify `/booking` loads available slots from Google Calendar.

## Phase 8: Webhook Configuration and Smoke Tests

- [ ] Sanity webhook targets `https://<production-domain>/api/revalidate`, dataset `production`, method `POST`, projection `{ _type }`, and production `SANITY_WEBHOOK_SECRET`.
- [ ] Publish a safe production Studio edit, verify signed webhook delivery, Vercel revalidation logs, cache tag, and public page update.
- [ ] Helcim webhook smoke: verify `/api/webhooks/card-transactions` accepts a production/test-approved card transaction event with redacted evidence.
- [ ] Square webhook smoke when service booking Square is enabled: verify `/api/webhooks/square` signature validation, idempotency, private hold/payment reconciliation, and finalizer behavior.
- [ ] Resend webhook smoke: verify contact unsubscribe/update event reaches the private consent ledger.
- [ ] Upstash smoke: verify OAuth token read/write, booking locks, idempotency keys, and TTL behavior with redacted key evidence.

## Phase 9: Public Page and Private-Flow Smoke Matrix

### Public Pages

| Page | Check | Result |
| --- | --- | --- |
| `/` | Home content, nav, global settings | |
| `/contact` | Contact page content and form renders | |
| `/gallery` | Gallery content and images | |
| `/products` | Product cards, availability, pricing | |
| `/products/[slug]` | Product detail, variants, checkout CTA | |
| `/services` | Service listing | |
| `/services/[slug]` | Service detail | |
| `/booking` | Booking settings and slots | |
| `/training-programs` | Training listing; `/training` redirects here | |
| `/training-programs/[slug]` | Training detail and checkout/schedule gates | |

### Private Flows

Use approved test data only and redact all customer/payment details in evidence.

- [ ] General inquiry writes to private DB and sends Resend email; no Sanity submission document is created.
- [ ] Training contact writes to private DB and sends Resend email; no Sanity submission document is created.
- [ ] Contact popup/marketing signup writes consent/submission evidence to private DB and Resend segment.
- [ ] Booking marketing opt-in and no-opt-in choices are recorded correctly in private DB.
- [ ] Product checkout uses Helcim and persists private order/payment state.
- [ ] Training checkout uses Helcim and exposes scheduling only through eligible paid token flow.
- [ ] Paid service booking uses Square only when enabled, creates a private hold, verifies payment server-side, then creates/fetches one Google Calendar event.

## Phase 10: Monitoring, Rollback, Failure Handling, and Evidence Capture

- [ ] Monitor Vercel runtime logs for `/api/revalidate`, `/api/webhooks/card-transactions`, `/api/webhooks/square`, booking routes, checkout routes, form actions, email retries, and private-data retention cron.
- [ ] Monitor provider dashboards for Helcim, Square, Resend, Google OAuth/API, Upstash, Sanity webhook deliveries, and database health.
- [ ] If Sanity import is wrong but production app is otherwise stable, stop content edits and decide whether to re-import from `./production-pre-cutover-backup.tar.gz` or roll forward with a corrected staging export.
- [ ] If DB migration fails, stop and follow `docs/private-database-migration-runbook.md`; do not manually edit production schema.
- [ ] If payment, booking, or form flows fail, pause those launch actions, preserve sanitized logs, and disable/rollback only through the approved deploy/provider path.
- [ ] Capture final evidence table with sanitized results and approver sign-off.

## Related Documents

- `.env.local.example`
- `docs/launch-readiness-checklist.md`
- `docs/sanity-staging-production-workflow.md`
- `docs/production-readiness-migration-plan.md`
- `docs/private-database-migration-runbook.md`
- `docs/google-calendar-oauth-env-setup.md`
- `docs/booking-system-setup-guide.md`
- `docs/square-service-booking-setup.md`
- `docs/resend-transactional-email-setup.md`
- `docs/resend-webhook-dashboard-setup-tutorial.md`
- `docs/booking-payment-provider-split.md`
