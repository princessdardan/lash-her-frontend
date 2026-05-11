# Private Checkout Storage Setup Guide

This guide describes how to set up and maintain the private PostgreSQL database used for Lash Her checkout records. This storage is separate from the public Sanity CMS and holds sensitive transaction history, customer contact details, checkout token hashes, encrypted Helcim secret tokens, invoice references, transaction references, and payment status.

Sanity remains the public catalog and editorial CMS only. Do not store checkout transaction history, customer PII, checkout tokens, Helcim invoice identifiers, Helcim transaction identifiers, payment reconciliation records, or encrypted Helcim secret tokens in a public Sanity dataset or expose them through Sanity Studio.

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
# Private PostgreSQL connection string
CHECKOUT_DATABASE_URL="postgres://user:password@host:port/dbname?sslmode=require"

# Base64-encoded 32-byte key for AES-256-GCM encryption
CHECKOUT_SECRET_ENCRYPTION_KEY="your-base64-key"

# Helcim API credentials
HELCIM_API_TOKEN="your-helcim-api-token"

# Required to receive Helcim webhooks
HELCIM_WEBHOOK_VERIFIER_TOKEN="your-webhook-verifier-token"

# Public Sanity catalog/editorial configuration
NEXT_PUBLIC_SANITY_PROJECT_ID="3auncj84"
NEXT_PUBLIC_SANITY_DATASET="staging-2026-05-10-or-production"
NEXT_PUBLIC_SANITY_API_VERSION="2026-03-24"
```

Use `CHECKOUT_DATABASE_URL` for checkout storage. `DATABASE_URL` may be accepted as a deployment fallback by the application, but prefer the checkout-specific variable so the private data boundary is obvious.

## Drizzle Migration Commands

Run these commands from the `frontend` directory to keep your database schema in sync.

```bash
# Generate migration files after schema changes
npm run db:generate

# Apply migrations to the database in CHECKOUT_DATABASE_URL
npm run db:migrate
```

Run migrations against staging first. Only run production migrations after staging checkout has been validated and the production connection string is confirmed.

## Helcim Configuration

1. Log in to the Helcim account.
2. Confirm API access is enabled for the account.
3. Generate or copy the server API token and add it to `HELCIM_API_TOKEN` in Vercel and local server-only env files.
4. Keep HelcimPay.js initialization on the secure backend. The browser should receive only the Helcim `checkoutToken`.
5. Keep the Helcim `secretToken` server-side, encrypt it with `CHECKOUT_SECRET_ENCRYPTION_KEY`, and store only the ciphertext in the private database.

### Helcim Webhook Setup

Helcim webhook handling is implemented in the app, but the external Helcim dashboard and deployment secrets still need human configuration:

1. Enable webhooks in Helcim under **All Tools -> Integrations -> Webhooks**.
2. Set the staging webhook delivery URL to `https://<staging-domain>/api/webhooks/helcim`.
3. Set the production webhook delivery URL to `https://<production-domain>/api/webhooks/helcim`.
4. The webhook URL must use HTTPS and must not contain the word `Helcim`.
5. Copy the webhook verifier token into `HELCIM_WEBHOOK_VERIFIER_TOKEN`.
6. Verify webhook signatures with HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.<raw-body>` using the base64-decoded verifier token.
7. Store webhook idempotency keys or event IDs in the private database before updating order state.

## Sanity Cleanup and Retention

The 2026-05-10 security remediation moves checkout orders out of Sanity. If a public Sanity dataset contains legacy `checkoutOrder` documents, follow these steps.

1. Export production Sanity before cleanup:

   ```bash
   npx sanity dataset export production ./production-before-checkout-cleanup.tar.gz \
     --project-id 3auncj84 \
     --overwrite
   ```

2. Count existing records with GROQ:

   ```groq
   count(*[_type == "checkoutOrder"])
   ```

3. Inspect a small sample only after confirming the operator has permission to view potentially sensitive customer data.
4. If records exist, choose one retention path before deletion:
   - delete without importing because records are confirmed test data,
   - export to an encrypted archive and then delete,
   - migrate selected records into private Postgres and then delete,
   - retain temporarily while hidden from Studio, with a written deletion date.
5. Do not delete production records until private storage is live, a backup exists, and retention/export/deletion requirements are approved by the business owner.

## Retention and Redaction

Keep order records only as long as required for accounting, support, fulfillment, chargeback, tax, and bookkeeping purposes. Do not invent a legal retention period in code; the business owner must choose it.

1. Identify your business and legal retention requirements for customer PII.
2. Use a redaction policy to remove `customer_name`, `customer_email`, and any future phone/address/freeform note fields after the retention window.
3. Retain non-PII data such as order IDs, totals, status, timestamps, and Helcim references for long-term financial reconciliation.
4. If an internal order dashboard is approved later, add audit logs for who viewed or changed private orders, when, and what action was taken.

## Smoke Test Checklist

- [ ] Database migrations apply without errors.
- [ ] Checkout initialization creates a pending row in the private database.
- [ ] Helcim payment success updates the private database row to "paid".
- [ ] No `checkoutOrder` documents are created in Sanity during a test transaction.
- [ ] Sanity Studio does not display an "Orders" section.
- [ ] Confirmation page still shows the public-safe order reference.
- [ ] Sanity remains limited to public catalog/editorial content.
