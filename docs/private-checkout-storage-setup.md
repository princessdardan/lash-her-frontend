# Shared Private PII Storage Setup Guide

This guide describes how to set up and maintain the private PostgreSQL database used for Lash Her sensitive operational records. This storage is separate from the public Sanity CMS and holds appointment holds, checkout records, payment events, training enrollments, paid training schedule token state, marketing contacts, contact submissions, consent events, provider references, invoice references, transaction references, and payment/booking status.

It also stores checkout token hashes and encrypted Helcim secret tokens for the Helcim-backed product/training flows.

Sanity remains the public catalog/editorial CMS and historical submission backfill source only. Do not store new checkout transaction history, customer PII, form/contact submissions, marketing contacts, consent events, checkout tokens, Square identifiers, Helcim invoice identifiers, Helcim transaction identifiers, payment reconciliation records, service holds, paid training schedule tokens, or encrypted provider secrets in a public Sanity dataset or expose them through Sanity Studio.

Related workstreams:

- `docs/private-database-migration-runbook.md` for migration, smoke, and backfill procedures.
- `docs/marketing-contact-privacy-compliance-follow-up.md` for compliance planning support.
- `docs/superpowers/plans/2026-05-17-marketing-contact-privacy-compliance-hardening.md` for checkbox implementation tasks.

## Database Setup

Use a managed PostgreSQL provider such as Neon, Supabase, Render Postgres, Railway Postgres, or an equivalent private server-side Postgres instance. Neon is the recommended default for this small Next.js/Vercel deployment.

1. Create a new PostgreSQL project in the chosen provider.
2. Create separate staging and production databases, branches, or projects.
3. Copy the pooled connection string for staging and the pooled connection string for production.
4. Store the staging connection string only in local/staging environments.
5. Store the production connection string only in production deployment environments.
6. Ensure database access is server-side only. Never place database URLs in browser-exposed variables or Sanity content.
7. Enable automated backups and point-in-time recovery if the provider plan allows it.
8. If using Neon, protect the production branch/database and keep staging on a separate branch/database.
9. If using Supabase, keep checkout tables out of browser-exposed access paths. If the schema is exposed to Supabase APIs, enable and verify restrictive RLS policies before storing real PII.

## Environment Variables

Add these variables to the matching Vercel environment and local `.env.local` file. Never prefix private values with `NEXT_PUBLIC_` because `NEXT_PUBLIC_*` values are browser-visible.

```env
# Private PostgreSQL connection string injected by Neon
DATABASE_URL="<server-only-pooled-postgres-url>"

# Base64-encoded 32-byte key for AES-256-GCM encryption
CHECKOUT_SECRET_ENCRYPTION_KEY="your-base64-key"

# Helcim API credentials
HELCIM_GENERAL_API_TOKEN="your-helcim-general-api-token"
HELCIM_TRANSACTION_API_TOKEN="your-helcim-transaction-api-token"

# Required to receive Helcim webhooks
HELCIM_WEBHOOK_VERIFIER_TOKEN="your-webhook-verifier-token"

# Square service booking checkout, server-only
SERVICE_BOOKING_SQUARE_ENABLED="false"
SQUARE_ENVIRONMENT="sandbox"
SQUARE_ACCESS_TOKEN="your-square-access-token"
SQUARE_LOCATION_ID="your-square-location-id"
SQUARE_WEBHOOK_SIGNATURE_KEY="your-square-webhook-signature-key"
SQUARE_SERVICE_BOOKING_RETURN_URL="https://yourdomain.com/api/booking/square/return"
SQUARE_SERVICE_BOOKING_WEBHOOK_URL="https://yourdomain.com/api/webhooks/square"

# Public Sanity catalog/editorial configuration
NEXT_PUBLIC_SANITY_PROJECT_ID="3auncj84"
NEXT_PUBLIC_SANITY_DATASET="staging-2026-05-10-or-production"
NEXT_PUBLIC_SANITY_API_VERSION="2026-03-24"
```

Private storage uses `DATABASE_URL`, which is injected by the Neon integration. Do not use `DATABASE_URL_UNPOOLED` for the runtime; the app creates a pooled `pg` client. Keep Square and Helcim secrets server-only. Product checkout and training checkout remain Helcim-backed and should not require Square variables.

## Drizzle Migration Commands

Run these commands from the repository root to keep your database schema in sync.

For the full migration procedure, target verification steps, evidence template, stop conditions, and rollback guidance, use `docs/private-database-migration-runbook.md`.

```bash
# Generate migration files after schema changes
npm run db:generate

# Apply migrations to the database in DATABASE_URL
npm run db:migrate
```

Run migrations against staging first. Only run production migrations after staging checkout, form/contact, and consent storage has been validated and the production connection string is confirmed.

## Migration Runbook and Evidence

Production migrations must never use schema push. Use only generated SQL migrations. Before running migrations against production, the operator must verify staging success and backup status.

### Database Identity Verification

Do not store full connection strings or passwords in this document. Record only the host or project identifiers to confirm the target.

**Staging Identity:**
- [ ] Provider: (e.g., Neon)
- [ ] Project/Branch ID:
- [ ] Host Label:
- [ ] Verified by connecting and checking for test data: [Yes/No]

**Production Identity:**
- [ ] Provider: (e.g., Neon)
- [ ] Project/Branch ID:
- [ ] Host Label:
- [ ] Verified by checking Vercel production environment variables: [Yes/No]

### Migration Evidence Template

Copy this template for every migration run.

| Field | Value |
| --- | --- |
| Environment | (Staging / Production) |
| Provider | |
| Host/Dashboard Label | |
| Branch/Project/DB ID | |
| Migration Version/File | |
| Backup/PITR Status | (Verified / Pending / Provider limitation recorded) |
| Operator | |
| Verifier | |
| Approver | |
| Timestamp | |
| Result | (Success / Failure) |
| Rollback Notes | |

**Production Constraint:** Production migration cannot proceed while Backup/PITR status is "Pending" or "Unverified".

### Stop and Rollback Criteria

Stop immediately if:
1. The migration command returns a non-zero exit code.
2. The database becomes unreachable after migration.
3. Staging smoke tests fail after migration.
4. `DATABASE_URL` cannot be independently verified as the correct target.
5. Production backups or PITR are unavailable or unverified.
6. The migration approver has not signed off on the production run.

**Rollback/Roll-forward Guidance:**
- If a migration fails partially, do not attempt to fix it by manually editing the database schema.
- Restore from the pre-migration backup or PITR snapshot.
- If the failure is due to a missing dependency, resolve the dependency in a new migration file and roll forward in staging first.

## Helcim Configuration

Helcim is the provider for product checkout and training checkout. New paid service bookings use Square hosted checkout instead.

1. Log in to the Helcim account.
2. Confirm API access is enabled for the account.
3. Generate or copy the general API token and add it to `HELCIM_GENERAL_API_TOKEN` in Vercel and local server-only env files. This token is used for invoice creation and card-transaction lookup.
4. Generate or copy the transaction-processing API token and add it to `HELCIM_TRANSACTION_API_TOKEN`. This token is used only for HelcimPay initialization.
5. Keep HelcimPay.js initialization on the secure backend. The browser should receive only the Helcim `checkoutToken`.
6. Keep the Helcim `secretToken` server-side, encrypt it with `CHECKOUT_SECRET_ENCRYPTION_KEY`, and store only the ciphertext in the private database.

## Square Service Booking Configuration

Square is the provider only for paid service booking checkout.

1. Confirm the Square app, location, and environment for the deployment.
2. Add `SERVICE_BOOKING_SQUARE_ENABLED=true` only where service booking checkout should use Square.
3. Set `SQUARE_ENVIRONMENT` to `sandbox` for local and preview, or `production` for live production.
4. Add `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, and `SQUARE_WEBHOOK_SIGNATURE_KEY` as server-only variables.
5. Set `SQUARE_SERVICE_BOOKING_RETURN_URL` to `https://<domain>/api/booking/square/return`.
6. Set `SQUARE_SERVICE_BOOKING_WEBHOOK_URL` to `https://<domain>/api/webhooks/square`.
7. In Vercel, scope sandbox values to Development and Preview, and scope production values to Production.

Service bookings keep the custom Lash Her UI, create private Postgres holds, then redirect to Square hosted checkout. Square return is not proof of payment. Webhook and return handling must reconcile server-side before finalization. Verified Square service payment finalizes through idempotent private DB state and Google Calendar API event creation.

If a verified paid service hold is expired or conflicts with another booking, mark it for rebooking-first manual review. Staff should offer a replacement time, verify availability before creating a Calendar event, and refund only after rebooking fails or staff chooses refund.

### Helcim Webhook Setup

Helcim webhook handling is implemented in the app, but the external Helcim dashboard and deployment secrets still need human configuration:

1. Enable webhooks in Helcim under **All Tools -> Integrations -> Webhooks**.
2. Set the staging webhook delivery URL to `https://<staging-domain>/api/webhooks/card-transactions`.
3. Set the production webhook delivery URL to `https://<production-domain>/api/webhooks/card-transactions`.
4. The webhook URL must use HTTPS and must not contain the word `helcim` or `Helcim`.
5. Copy the webhook verifier token into `HELCIM_WEBHOOK_VERIFIER_TOKEN`.
6. Verify webhook signatures with HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.<raw-body>` using the base64-decoded verifier token.
7. Store webhook idempotency keys or event IDs in the private database before updating order state.

## Sanity Cleanup and Retention

The private storage remediation moves sensitive operational records out of Sanity. If a public Sanity dataset contains legacy `checkoutOrder`, `generalInquiry`, `contactForm`, `contactPopupSubmission`, or `bookingMarketingOptIn` documents, treat them as historical/backfill records until a retention/export/redaction decision is documented.

1. Export production Sanity before cleanup:

   ```bash
   npx sanity dataset export production ./production-before-checkout-cleanup.tar.gz \
     --project-id 3auncj84 \
     --overwrite
   ```

2. Count existing records with GROQ:

    ```groq
    count(*[_type in ["checkoutOrder", "generalInquiry", "contactForm", "contactPopupSubmission", "bookingMarketingOptIn"]])
    ```

3. Inspect a small sample only after confirming the operator has permission to view potentially sensitive customer data.
4. If records exist, choose one retention path before deletion/redaction:
    - delete without importing because records are confirmed test data,
    - export to an encrypted archive and then delete,
    - migrate selected records into private Postgres and then delete,
    - retain temporarily while hidden from Studio, with a written deletion date.
5. Do not delete production records until private storage is live, a backup exists, and retention/export/deletion requirements are approved by the business owner.

## Retention and Redaction

Keep private records only as long as required for their approved purposes. Checkout records may be needed for accounting, support, fulfillment, chargeback, tax, and bookkeeping purposes. Marketing contacts, contact submissions, consent events, suppression records, and Sanity backfill records need separate owner/counsel retention and redaction decisions. Do not invent legal retention periods in code or docs.

### Retention Decision Record

| Decision Point | Value |
| --- | --- |
| Retention Owner | |
| Decision Date | |
| Checkout PII Retention Period | (Business/legal decision) |
| Marketing Contact Retention Period | (Business/legal decision) |
| Contact Submission Retention Period | (Business/legal decision) |
| Consent Event Retention Period | (Business/legal decision) |
| Suppression Record Retention Period | (Business/legal decision) |
| Sanity Backfill Retention/Redaction Path | (Business/legal decision) |
| Financial Record Period | (Business/legal decision) |
| Redaction Approval | |

### Future Redaction Behavior

Once retention periods and record-type rules are defined, a manual or automated job will:
1. Remove approved PII fields from checkout, contact, marketing, and submission records.
2. Preserve only approved non-PII reconciliation, accounting, suppression, provenance, and audit fields.
3. Log the redaction event without including the redacted data.

**Access Control Warning:**
No order/contact dashboard or internal UI should be added until access control, audit logging, and a formal retention policy are defined and implemented.

Contractor access should be least-privilege and time-bound. Dardan acts as contract technical operator/steward only while actively engaged; Nataliea remains accountable for business/privacy decisions and must name an ongoing owner or vendor before launch. Revoke or rotate contractor access when the contract ends or scope changes.

## Smoke Test Checklist

- [ ] Database migrations apply without errors.
- [ ] Product checkout and training checkout initialization create Helcim-backed pending rows in the private database.
- [ ] Service booking hold creation stores a private hold row before Square checkout starts.
- [ ] Square payment success updates the private database row to "paid" and moves paid service booking holds to booked or `paid_unbookable_rebooking_pending` after finalization.
- [ ] Helcim payment success updates product/training private database rows without requiring Square variables.
- [ ] Paid training schedule token data stays in private Postgres and does not appear in Sanity.
- [ ] No `checkoutOrder` documents are created in Sanity during a test transaction.
- [ ] General inquiry, training contact, and contact popup submissions create private DB submission/consent records before email.
- [ ] Booking marketing choices create private DB audit records for both opted-in and not-opted-in paths.
- [ ] No `generalInquiry`, `contactForm`, `contactPopupSubmission`, or `bookingMarketingOptIn` documents are created in Sanity by live flows.
- [ ] Sanity Studio does not display an "Orders" section.
- [ ] Confirmation page still shows the public-safe order reference.
- [ ] Sanity remains limited to public catalog/editorial content.
