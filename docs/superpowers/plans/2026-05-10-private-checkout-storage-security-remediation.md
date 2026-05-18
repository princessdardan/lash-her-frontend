# Private Checkout Storage Security Remediation Plan

> **Historical note (2026-05-17):** This plan was intentionally scoped to checkout storage. Current private DB documentation supersedes it by treating the database as shared private PII storage for checkout orders, payment events, training enrollments, marketing contacts, contact submissions, and consent events.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Security constraint:** Do not store checkout transaction history, customer PII, payment reconciliation records, checkout tokens, Helcim invoice identifiers, Helcim transaction identifiers, or encrypted Helcim secret tokens in a public Sanity dataset. Sanity may continue to store public catalog/content only.

**Goal:** Remove transaction-history and customer-PII persistence from Sanity, replace it with a private server-side datastore, and create human-facing setup guides for the services, secrets, migrations, and operational checks required to run checkout safely.

**Architecture:** Keep Sanity as the public content/catalog source for `sellableProduct` and editorial configuration. Move `checkoutOrder` persistence behind a server-only repository backed by a private PostgreSQL database. Preserve the existing HelcimPay.js flow: server validates catalog price/availability, creates Helcim invoice, initializes HelcimPay, stores a pending private order, validates the Helcim iframe response server-side, and marks the private order paid or failed. Add optional Helcim webhook infrastructure only after the private database is in place.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Sanity v4/next-sanity for public CMS content, Helcim v2 API and HelcimPay.js, PostgreSQL for private checkout records, Drizzle ORM/drizzle-kit for typed schema and migrations, Neon or equivalent managed Postgres for hosted staging/production databases, Playwright E2E, `tsx --test` unit tests.

---

## Current Security Finding

The current implementation stores checkout reconciliation records in public Sanity documents:

- Schema: `frontend/src/sanity/schemas/documents/checkout-order.ts`
- Storage implementation: `frontend/src/lib/commerce/order-store.ts`
- Checkout initialization: `frontend/src/app/api/checkout/route.ts`
- Payment validation: `frontend/src/app/api/checkout/validate-payment/route.ts`
- Studio exposure: `frontend/src/sanity/structure/index.ts`
- Schema registration: `frontend/src/sanity/schemas/index.ts`
- Types/docs/tests mention `checkoutOrder` and Sanity order storage.

Those records include customer name, customer email, order amount, line items, checkout token, encrypted Helcim secret token, Helcim invoice ID/number, Helcim transaction ID, and payment status. Encryption protects only the Helcim secret token, not the customer PII or transaction metadata. If the Sanity dataset is public, unauthenticated reads can expose this information.

Booking is already safer: confirmed booking history is not stored in Sanity. Google Calendar is the booking source of truth, Upstash Redis stores operational booking secrets/locks/idempotency, and Sanity stores only `bookingSettings` plus optional `bookingMarketingOptIn` documents.

## Locked Scope

This remediation plan is intentionally scoped to private checkout storage and required operational documentation.

Allowed:

- Add a private PostgreSQL-backed order repository.
- Add database schema/migrations for checkout orders and payment events.
- Replace Sanity `checkoutOrder` reads/writes in checkout code.
- Remove `checkoutOrder` from active Sanity schema and Studio navigation after migration/export decisions are complete.
- Add docs for human setup: database provider, environment variables, migrations, Helcim settings, Vercel configuration, production cleanup.
- Add tests proving no checkout PII is written to Sanity.

Not allowed without separate approval:

- Adding customer accounts.
- Adding an admin order dashboard.
- Adding refunds, shipping, discounts, taxes, ACH, Fee Saver, partial payments, saved payment methods, or inventory management.
- Storing payment card data, bank data, full Helcim webhook payloads, or raw browser payment payloads.
- Migrating booking history into Sanity or the new checkout database.
- Blindly deleting production Sanity documents before a human has exported/backed them up.

If implementation discovers production `checkoutOrder` documents with real customer data, stop before deletion and ask the human to confirm export/retention/deletion requirements.

## Recommended Storage Decision

Use private PostgreSQL, preferably Neon Postgres or Supabase Postgres for this small Next.js/Vercel deployment.

Rationale:

- Transaction history needs relational constraints, durable auditability, queryability, and private access.
- Upstash Redis is already used for operational booking locks/tokens, but it is not the right long-term order ledger.
- Helcim remains the payment processor and external source of payment truth, but the site still needs a private local reconciliation record for checkout status, customer contact, line-item snapshot, and operational support.
- Drizzle provides typed schema and migration generation without adding a large framework.
- Supabase is acceptable when row-level security, backups/PITR, and service-role separation are configured correctly; Neon is acceptable when separate protected staging/production branches/databases, TLS, backups/PITR, and server-only connection strings are configured correctly.

Recommended data boundary:

- Sanity: public catalog/editorial data only (`sellableProduct`, page content, booking settings).
- PostgreSQL: private checkout order reconciliation, customer contact, line-item snapshots, encrypted Helcim secret token, invoice/transaction references, status, timestamps.
- Helcim: payment processing, payment records, invoices, processor-side transaction details.
- Google Calendar/Redis: unchanged booking implementation.

## Target Private Database Model

Create two or three tables first. Keep the model small until an admin order UI or webhook-driven fulfillment is approved.

`checkout_orders`:

- `id` UUID primary key.
- `order_id` text unique, public-safe reference shown on confirmation pages.
- `status` text: `pending`, `paid`, `verification_failed`, `cancelled`, `refunded`.
  - `refunded` is reserved private reconciliation state for externally/manual Helcim handling only. Refund workflows and admin refund tooling remain out of scope unless separately approved.
- `checkout_token_hash` text unique or indexed. Do not store raw checkout token if lookup can use a deterministic HMAC/hash.
- `secret_token_ciphertext` text. Existing AES-256-GCM helper can remain if encryption key stays server-only.
- `helcim_invoice_id` integer or bigint.
- `helcim_invoice_number` text.
- `helcim_transaction_id` text nullable.
- `customer_name` text.
- `customer_email` text.
- `amount_cents` integer.
- `currency` text, default `CAD`.
- `line_items` JSONB snapshot containing SKU, description, quantity, unit price cents, total cents.
- `created_at` timestamp.
- `updated_at` timestamp.
- `paid_at` timestamp nullable.
- `failed_at` timestamp nullable.
- `redacted_at` timestamp nullable.
- `deleted_at` timestamp nullable if soft deletion is required.

For the first implementation, `line_items` may be JSONB if no order admin/reporting UI is approved. If admin filtering/reporting by SKU or product becomes required, use a normalized `checkout_order_items` table instead:

- `id` UUID primary key.
- `order_id` foreign key to `checkout_orders.id` with cascade delete.
- `sanity_product_id` text nullable.
- `sku` text.
- `name` text.
- `quantity` integer.
- `unit_price_cents` integer.
- `line_total_cents` integer.
- `metadata` JSONB nullable.

`checkout_payment_events`:

- `id` UUID primary key.
- `order_id` foreign key to `checkout_orders.id`.
- `event_type` text: `browser_validation_success`, `browser_validation_failed`, `helcim_webhook_received`, `helcim_webhook_rejected`, etc.
- `helcim_transaction_id` text nullable.
- `status` text nullable.
- `amount_cents` integer nullable.
- `currency` text nullable.
- `message` text nullable.
- `created_at` timestamp.
- `idempotency_key` text unique nullable for future webhook events.
- `payload_redacted` JSONB nullable only if a redaction policy is implemented.

Do not store:

- Card numbers, CVV, expiry, bank data, card tokens, or raw payment method details.
- Raw Helcim API token or webhook verifier token.
- Raw `secretToken`.
- Full raw Helcim webhook/body payloads unless a specific redaction policy is implemented.
- Customer address/phone unless a future fulfillment requirement explicitly requires it.

Retention rule:

- Keep order records only as long as needed for accounting, chargeback, fulfillment, and support.
- Add a future retention/redaction job once legal/business retention requirements are known.
- Prefer redacting customer PII while retaining non-PII totals, status, timestamps, and Helcim references needed for reconciliation.

## Task 1: Confirm Branch, Risk, and Human Decisions

**Files:**
- No source changes.

- [x] **Step 1: Confirm worktree state**

Run from `/Users/dardan/Documents/lash-her-booking-helcim-integration`:

```bash
git status --short --branch
git log --oneline -5
```

Expected:
- Worktree and branch are understood before editing.
- Existing unrelated worktree changes are not reverted.

- [x] **Step 2: Confirm Sanity dataset privacy constraint**

Run from `frontend` with the correct project ID:

```bash
npx sanity datasets visibility get production --project-id 3auncj84
npx sanity datasets visibility get staging-2026-05-10 --project-id 3auncj84
```

Expected:
- If production/`staging-2026-05-10` are public-only, this remediation remains mandatory.
- If a private dataset is available later, still prefer private database for transaction history unless product ownership explicitly chooses Sanity ACLs for order records.

- [x] **Step 3: Human approval checkpoint**

Ask the human to confirm:

- Preferred database provider: Neon Postgres recommended, Supabase/Render/Railway Postgres acceptable.
- Whether any existing production `checkoutOrder` documents contain real data.
- Whether existing Sanity `checkoutOrder` records must be exported before deletion.
- Whether Helcim webhooks are in scope for this remediation or should remain a follow-up.

Expected:
- Do not begin destructive cleanup or production migration until these answers are recorded.

## Task 2: Write Human Setup Guide for Private Services

**Files:**
- Create: `docs/private-checkout-storage-setup.md`
- Modify: `docs/sanity-staging-production-workflow.md` if needed to point to the new guide.
- Modify: `docs/booking-helcim-implementation-summary.md` so the handoff no longer says Sanity stores `checkoutOrder` records.
- Modify: `docs/superpowers/specs/2026-05-04-helcimpay-design.md` so the canonical Helcim design names private checkout storage instead of Sanity order documents.
- Modify: `docs/superpowers/specs/2026-05-09-training-products-sanity-commerce-design.md` if it still refers to `checkoutOrder` as an acceptable public Sanity reconciliation record.
- Modify: `frontend/README.md` if env setup belongs in developer docs.
- Modify: `frontend/.env.local.example` if present.

- [x] **Step 1: Document Neon/Postgres setup**

Create a guide that tells the human how to:

1. Create a Neon/Supabase project or equivalent managed Postgres instance.
2. Create separate staging and production databases or branches.
3. Copy the staging and production pooled connection strings.
4. Store the pooled Neon/Postgres connection string as `DATABASE_URL` in the correct deployment environments.
5. Restrict database access to server-side environments only.
6. Enable backups/point-in-time restore if available on the chosen plan.
7. If using Supabase, keep checkout tables out of browser-exposed access paths and enable/verify RLS policies if the schema is exposed.
8. If using Neon, use protected production branches/databases and separate staging connection strings.

Expected:
- A non-developer owner can follow the guide and know exactly which values to copy into Vercel/local env files.

- [x] **Step 2: Document Vercel/local environment setup**

Document required env vars:

```env
DATABASE_URL=<private-postgres-url>
CHECKOUT_SECRET_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
HELCIM_GENERAL_API_TOKEN=<server-only-helcim-general-token>
HELCIM_TRANSACTION_API_TOKEN=<server-only-helcim-transaction-token>
HELCIM_WEBHOOK_VERIFIER_TOKEN=<server-only-webhook-verifier-token-if-webhooks-in-scope>
NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84
NEXT_PUBLIC_SANITY_DATASET=<staging-2026-05-10-or-production>
NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24
```

Expected:
- The guide explicitly says never to put database URLs or Helcim secrets in `NEXT_PUBLIC_*` variables.

- [x] **Step 3: Document Helcim setup**

Document how the human should:

1. Confirm Helcim API access configuration.
2. Copy server API token into Vercel env.
3. If webhooks are included, enable Helcim webhooks under Integrations.
4. Set the webhook delivery URL to the production HTTPS endpoint.
5. Copy the webhook verifier token into `HELCIM_WEBHOOK_VERIFIER_TOKEN`.
6. Note Helcim's webhook URL restriction: URL must use HTTPS and must not contain the word `Helcim`.

Expected:
- The guide includes staging and production URL placeholders and a smoke-test checklist.

- [x] **Step 4: Document production Sanity cleanup**

Add a section for the human to:

1. Export production Sanity before cleanup.
2. Query for `checkoutOrder` count.
3. Decide retention/export/deletion.
4. Delete or archive public Sanity `checkoutOrder` records only after private storage is live and historical handling is approved.

Expected:
- No destructive production action is implied as automatic.

## Task 3: Add Private Database Dependencies and Configuration

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/drizzle.config.ts`
- Create: `frontend/src/lib/private-db/schema.ts`
- Create: `frontend/src/lib/private-db/client.ts`
- Create: `frontend/src/lib/private-db/migrate.ts` or `frontend/scripts/migrate-private-db.ts`
- Modify: `frontend/src/sanity/env.ts` or create dedicated `frontend/src/lib/env/private-checkout.ts`

- [x] **Step 1: Install dependencies**

Run from `frontend`:

```bash
npm install drizzle-orm pg
npm install -D drizzle-kit @types/pg
```

Expected:
- `package.json` reflects private database dependencies.
- No public client bundle imports these packages.

- [x] **Step 2: Add private env helper**

Create a server-only helper for checkout database config using Neon's injected `DATABASE_URL`:

```ts
import "server-only";

export function getCheckoutDatabaseUrl(): string {
  return assertValue(
    process.env.DATABASE_URL,
    "Missing env var: DATABASE_URL"
  );
}
```

Expected:
- Database URL is asserted lazily only in server-side checkout/database code.
- No `NEXT_PUBLIC_*` database variables exist.

- [x] **Step 3: Define Drizzle schema**

Create `checkoutOrders` and `checkoutPaymentEvents` tables with the target model above.

Expected:
- `orderId` is unique.
- pending lookup uses a non-PII token lookup field.
- statuses are constrained by code and/or database checks.
- timestamps are represented consistently.

- [x] **Step 4: Add database client**

Create a server-only Drizzle/pg client using `DATABASE_URL`.

Expected:
- Client is imported only from route handlers/server-only libraries.
- Connection config supports hosted Postgres SSL where required.

- [x] **Step 5: Add migration scripts**

Add scripts to `frontend/package.json`:

```json
{
  "db:generate": "drizzle-kit generate",
  "db:migrate": "tsx scripts/migrate-private-db.ts"
}
```

Expected:
- `npx drizzle-kit generate` creates migrations under `frontend/drizzle`.
- `npm run db:migrate` applies migrations to the database named by `DATABASE_URL`.

## Task 4: Replace Sanity Order Store With Private Repository

**Files:**
- Modify: `frontend/src/lib/commerce/order-store.ts`
- Modify: `frontend/src/app/api/checkout/route.ts` only if response/types need adjustment.
- Modify: `frontend/src/app/api/checkout/validate-payment/route.ts` only if repository API changes.
- Modify/create tests under `frontend/src/lib/commerce/*.test.ts`.

- [x] **Step 1: Define repository contract**

Keep the existing public function names if possible:

- `createPendingOrder(input)`
- `getPendingOrderByCheckoutToken(checkoutToken)`
- `markOrderPaid(orderId, helcimTransactionId)`
- `markOrderVerificationFailed(orderId)`

Expected:
- Route handlers do not need broad rewrites.
- Function return shapes still satisfy `verifyHelcimPayment`.

- [x] **Step 2: Remove `writeClient` dependency from order store**

Replace Sanity `writeClient.create`, `writeClient.fetch`, and `writeClient.patch` with private database inserts/selects/updates.

Expected:
- `frontend/src/lib/commerce/order-store.ts` no longer imports `@/sanity/lib/write-client`.
- AST search for `writeClient.create` and `writeClient.patch` shows no checkout order writes.

- [x] **Step 3: Hash checkout tokens for lookup**

Store a deterministic server-side hash/HMAC of `checkoutToken` instead of raw token if feasible.

Expected:
- `getPendingOrderByCheckoutToken()` hashes the incoming token before lookup.
- Raw checkout token is not stored in the database unless Helcim operational needs require it and the decision is documented.

- [x] **Step 4: Preserve encrypted secret token handling**

Continue encrypting `secretToken` using `CHECKOUT_SECRET_ENCRYPTION_KEY` before storage.

Expected:
- Existing `checkout-secret.ts` tests still pass or are updated for the new repository boundary.
- No raw `secretToken` is stored.

- [x] **Step 5: Store money as cents**

Convert order amount and line item prices/totals into integer cents at persistence time.

Expected:
- Validation still compares Helcim amount to expected amount without floating point drift.
- Existing UI/API response shape remains unchanged.

## Task 5: Remove Active Sanity Order Schema and Studio Exposure

**Files:**
- Modify: `frontend/src/sanity/schemas/index.ts`
- Modify: `frontend/src/sanity/structure/index.ts`
- Modify: `frontend/src/sanity/sanity.config.ts` if singleton/action logic references order types.
- Modify: `frontend/src/types/index.ts`
- Modify: `frontend/src/app/api/revalidate/route.ts` only if any order-related tag is present or later added.
- Delete or deprecate: `frontend/src/sanity/schemas/documents/checkout-order.ts`
- Modify docs that instruct editors to use Studio Orders.

- [x] **Step 1: Remove active schema registration**

Remove `checkoutOrder` import and `schemaTypes` entry.

Expected:
- Sanity Studio no longer defines an order document type for new writes.

- [x] **Step 2: Remove Orders Studio section**

Remove the `Orders` section that exposes `checkoutOrder` in Studio structure.

Expected:
- Editors cannot browse public dataset transaction documents through the Studio.

- [x] **Step 3: Remove public checkout order types**

Remove `TCheckoutOrder` and related line-item/status types from `frontend/src/types/index.ts` unless still needed by private repository types.

Expected:
- Public CMS types no longer imply Sanity stores checkout orders.

- [x] **Step 3.5: Verify no revalidation coupling remains**

Inspect `frontend/src/app/api/revalidate/route.ts` and confirm no `checkoutOrder` tag is present.

Expected:
- Sanity webhook revalidation remains limited to public CMS/content types.

- [x] **Step 4: Delete or archive schema file**

If production Sanity cleanup is approved, delete `frontend/src/sanity/schemas/documents/checkout-order.ts`.

If cleanup is not yet approved, keep the file unregistered and add a comment/doc note that it is legacy and must not be re-registered.

Expected:
- No active Studio route can create or expose `checkoutOrder` documents.

## Task 6: Add Security Regression Tests

**Files:**
- Modify/create: `frontend/src/lib/commerce/order-store.test.ts`
- Modify: `frontend/src/lib/commerce/verified-payment.test.ts`
- Modify: `frontend/tests/checkout.spec.ts`
- Optional create: `frontend/src/lib/private-db/schema.test.ts`

- [x] **Step 1: Unit test private repository behavior**

Tests should cover:

- creates pending order in private repository,
- retrieves pending order by checkout token,
- decrypts secret token only in server repository code,
- marks paid with transaction ID,
- marks verification failed,
- does not call Sanity `writeClient`.

Expected:
- Tests can run without a real hosted database by using a repository abstraction or test database strategy.

- [x] **Step 2: Add static regression test or AST check**

Add a test/script that fails if checkout order persistence imports `@/sanity/lib/write-client` or writes `_type: "checkoutOrder"`.

Expected:
- Future agents cannot accidentally reintroduce public Sanity transaction storage.

- [x] **Step 3: Update checkout browser tests**

Keep existing checkout behavior expectations:

- checkout starts,
- Helcim iframe success payload is forwarded to validation route,
- confirmation redirects with order reference,
- initialization failure leaves cart intact.

Expected:
- User-facing behavior remains unchanged while storage changes.

## Task 7: Optional Helcim Webhook Hardening

**Files:**
- Create: `frontend/src/app/api/webhooks/card-transactions/route.ts` (Note: Helcim delivery URLs must not contain "helcim")
- Create: `frontend/src/lib/commerce/helcim-webhook.ts`
- Modify: `frontend/src/lib/commerce/order-store.ts`
- Modify: `frontend/src/sanity/env.ts` or private env helper.
- Modify docs guide from Task 2.

- [x] **Step 1: Confirm scope**

Do not implement webhooks unless the human approves it for this remediation.

Expected:
- If not approved, record webhooks as a follow-up.

- [x] **Step 2: Implement raw-body signature verification**

Helcim signs webhooks with HMAC SHA-256. The signed content is:

```text
<webhook-id>.<webhook-timestamp>.<raw-body>
```

Verification uses the base64-decoded Helcim verifier token and compares against the `webhook-signature` header.

Expected:
- The route reads raw body before JSON parsing.
- Invalid signatures return a non-success response and do not update orders.

- [x] **Step 3: Add idempotency**

Store webhook ID and transaction ID in `checkout_payment_events` or a dedicated table with a unique constraint.

Expected:
- Helcim retries do not duplicate order updates.

- [x] **Step 4: Reconcile transaction details**

Implemented Helcim card-transaction detail fetching and reconciliation to ensure private order records match processor-side transaction truth.

Expected:
- Do not store full raw transaction details unless redacted and documented.

## Task 8: Production Data Cleanup and Migration Guide

**Files:**
- Create or extend: `docs/private-checkout-storage-setup.md`
- Optional create: `frontend/scripts/export-public-sanity-checkout-orders.ts`
- Optional create: `frontend/scripts/delete-public-sanity-checkout-orders.ts`

- [x] **Step 1: Add backup instructions**

Document production backup before cleanup:

```bash
npx sanity datasets export production ./production-before-checkout-cleanup.tar.gz \
  --project-id 3auncj84 \
  --overwrite
```

Expected:
- Human has a recoverable export before deleting public data.

- [x] **Step 2: Add discovery query instructions**

Document how to count and inspect existing records:

```groq
count(*[_type == "checkoutOrder"])
```

Expected:
- Human knows whether public Sanity contains real records.

- [x] **Step 3: Add retention decision point**

If records exist, human chooses one:

- delete without importing because records are test data,
- export to encrypted archive then delete,
- migrate selected records into private Postgres then delete,
- retain temporarily while hidden from Studio, with a deletion date.

Expected:
- No automated script deletes production transaction data without explicit human approval.

- [ ] **Step 4: Add deletion script only if approved**

If approved, create a script that deletes only `_type == "checkoutOrder"` from the intended dataset and requires an explicit confirmation env var like `CONFIRM_DELETE_CHECKOUT_ORDERS=production`.

Expected:
- Script is impossible to run casually.
- Dry-run mode prints count and sample IDs only.

## Task 8.5: Update Historical and Handoff Documentation

**Files:**
- Modify: `docs/booking-helcim-implementation-summary.md`
- Modify: `docs/superpowers/specs/2026-05-04-helcimpay-design.md`
- Modify: `docs/superpowers/specs/2026-05-09-training-products-sanity-commerce-design.md`
- Modify: `docs/superpowers/plans/2026-05-05-helcimpay-implementation.md` only if a note is needed to mark the older plan superseded.
- Modify: `docs/superpowers/plans/2026-05-09-training-products-sanity-commerce-implementation.md` if it still directs future work toward Studio-visible checkout orders.
- Modify: `CLAUDE.md` only if repository guidance should warn against public Sanity transaction storage.

- [x] **Step 1: Mark old Sanity order-storage guidance superseded**

Add short notes to historical docs that originally proposed or implemented Sanity `checkoutOrder` storage.

Expected:
- Future agents do not follow the older 2026-05-05 Helcim plan and reintroduce the vulnerability.

- [x] **Step 2: Update implementation summary**

Change the handoff summary so checkout storage is described as private database-backed after remediation.

Expected:
- The summary accurately reflects the new security boundary.

- [x] **Step 3: Add persistent guardrail to project docs**

If appropriate, update `CLAUDE.md` or an AGENTS note with: do not store transaction history or customer payment PII in public Sanity datasets.

Expected:
- Future work inherits the security rule.

## Task 8.6: Add Retention and Access Guidance

**Files:**
- Create or extend: `docs/private-checkout-storage-setup.md`
- Optional create: `docs/private-checkout-retention-policy.md`

- [x] **Step 1: Document minimum retention decision**

Ask the human to decide how long customer PII should remain identifiable for support, chargebacks, bookkeeping, and tax/accounting purposes.

Expected:
- Implementation does not invent a legal retention period.

- [x] **Step 2: Document redaction behavior**

Define which fields should be redacted after the retention window, such as `customer_name`, `customer_email`, phone/address fields if later added, and any freeform notes.

Expected:
- Non-PII accounting totals, order IDs, Helcim references, status, and timestamps can remain for reconciliation.

- [x] **Step 3: Document admin access logging for future dashboards**

If an internal order dashboard is later approved, require audit logs for who viewed or changed private orders, when, and what action was taken.

Expected:
- Future admin tooling does not bypass private-data accountability.

## Task 9: Verification

**Files:**
- No source changes unless fixing issues caused by remediation.

- [x] **Step 1: LSP diagnostics**

Run diagnostics on every changed `.ts`/`.tsx` file.

Result: Passed.

- [x] **Step 2: Static searches**

Run:

```bash
rg -n "checkoutOrder|checkout-order|writeClient\.create|writeClient\.patch|_type:\s*[\"']checkoutOrder" frontend/src frontend/tests docs
```

Result: Active hits are private DB table names, tests, and docs only. No Sanity `writeClient` writes found.

- [x] **Step 3: Database migration verification**

Run from `frontend` with staging `DATABASE_URL`:

```bash
npm run db:generate
npm run db:migrate
```

Result: `db:generate` showed no schema changes. `db:migrate` exit 0 with pg SSL warning.

- [x] **Step 4: Unit tests**

Run:

```bash
npm run test:unit
```

Result: 62/62 passed.

- [x] **Step 5: Lint and build**

Run:

```bash
npm run lint
npm run build
```

Result: Lint exit 0 with 13 warnings. Build exit 0. `git diff --check` exit 0.

- [ ] **Step 6: Manual QA**

Use a browser against local or staging app:

- browse product catalog,
- add item to cart,
- start checkout,
- complete Helcim test flow or mocked staging flow,
- verify confirmation page shows order reference,
- verify private database row exists,
- verify Sanity has no new `checkoutOrder` document,
- verify Sanity Studio no longer exposes Orders.

Result: Partial. Checkout Playwright 3/3 passed on existing server after initial port conflict. Real Helcim payment, webhook dashboard, and private DB row verification not completed.

Expected:
- User-facing checkout still works.
- Transaction data is private.

## Stop Conditions

Stop and ask the human if any of these occur:

- The human has not chosen/approved a private database provider.
- Production Sanity contains real `checkoutOrder` documents and retention/deletion is undecided.
- The selected database plan does not support private server-side access suitable for PII.
- Implementing webhooks becomes necessary but Helcim webhook verifier token or public HTTPS URL is unavailable.
- Checkout behavior would need to change beyond storage location.
- Any migration/deletion could destroy production data without a backup.
- Any code path would still expose transaction history through a public Sanity dataset.

## Success Criteria

- Checkout order persistence no longer imports or writes through Sanity clients.
- Public Sanity schema and Studio no longer actively expose `checkoutOrder`.
- Private database migrations exist and can be applied to staging/production.
- Human setup guide explains database setup, env vars, Vercel configuration, Helcim setup, and Sanity cleanup.
- Tests verify checkout storage and prevent reintroducing Sanity order writes.
- Staging checkout works end-to-end with private storage.
- Production cleanup is documented and gated behind explicit human approval.

## Suggested Commit Sequence After Approval

Do not commit unless explicitly requested by the user.

Suggested sequence if commits are requested later:

1. `docs: plan private checkout storage remediation`
2. `docs: add private checkout setup guide`
3. `feat: add private checkout database schema`
4. `feat: move checkout order storage to private database`
5. `refactor: remove checkout orders from sanity studio`
6. `test: prevent sanity checkout order persistence`
7. `docs: add production checkout cleanup guide`
