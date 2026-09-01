# Sanity Staging and Production Workflow

## Canonical Git and Vercel Branch Target

The Vercel staging subdomain must target the `staging` branch in the frontend repository:

```text
https://github.com/princessdardan/lash-her-frontend
```

Do not create or push deployment branches to `https://github.com/princessdardan/lash-her`. In local checkouts, verify remotes with `git remote -v` before pushing. Use the `origin` remote from the repository root:

```bash
npm run git:push-staging
```

This document describes how to use the Lash Her staging Sanity Studio and the `staging-2026-05-10` dataset to test Studio/schema/content changes, then safely promote completed work to production.

Run app and Sanity commands from the repository root:

```bash
cd /Users/dardan/workspace/lash-her-frontend
```

## Current Project Findings

- The active application is the root Next.js app.
- The Sanity Studio is embedded at `/studio` through `src/app/studio/[[...tool]]/page.tsx`.
- Studio configuration lives in `src/sanity/sanity.config.ts`.
- Schemas are code-defined and manually registered in `src/sanity/schemas/index.ts`.
- Runtime Sanity targeting is environment-driven through `src/sanity/env.ts`:
  - `NEXT_PUBLIC_SANITY_PROJECT_ID`
  - `NEXT_PUBLIC_SANITY_DATASET`
  - `NEXT_PUBLIC_SANITY_API_VERSION`
- The Sanity project ID found in `sanity.cli.ts` is `3auncj84`.
- `sanity.cli.ts` targets `NEXT_PUBLIC_SANITY_DATASET` and refuses production schema operations unless `SANITY_SCHEMA_DEPLOY_TARGET=production` is set.
- The active source schema contains eight singletons: `homePage`, `contactPage`, `galleryPage`, `trainingPage`, `trainingProgramsPage`, `productsPage`, `globalSettings`, and `mainMenu`.
- Active collection document types are `product`, `productCollection`, `promotionCode`, `service`, `trainingProgram`, and `policyPage`.
- `bookingSettings` is not registered in the active schema, Studio structure, or Presentation configuration. Its remaining schema/loader code is legacy V1 migration and payment-reconciliation compatibility only. Current service-booking settings, catalog copy, intake configuration, availability, and booking state are PostgreSQL-owned and managed through `/admin`.

Important distinction: the Sanity Studio does not contain the content. The Studio is the editing application and schema code. Content lives in a Sanity Content Lake dataset. Copying production into staging means copying the production dataset into `staging-2026-05-10`; deploying Studio/schema code is a separate step.

## Recommended Environment Names

Use these names unless the Sanity project already has different conventions:

- Sanity project: `3auncj84`
- Production dataset: `production`
- Staging dataset: `staging-2026-05-10`

`staging-2026-05-10` is the actual staging dataset name. Do not use `staging` as a dataset alias or placeholder unless a future workflow explicitly creates that alias.

## Required Access and Secrets

Before proceeding, confirm you have:

- Sanity CLI access to project `3auncj84` with permission to manage datasets and deploy schemas.
- A Sanity token for CI/unattended commands, exposed only as `SANITY_AUTH_TOKEN` when needed.
- Separate staging and production values for:
  - `NEXT_PUBLIC_SANITY_PROJECT_ID`
  - `NEXT_PUBLIC_SANITY_DATASET`
  - `NEXT_PUBLIC_SANITY_API_VERSION`
  - `SANITY_API_READ_TOKEN`
  - `SANITY_WRITE_TOKEN`
  - `SANITY_WEBHOOK_SECRET`
  - `AUTH_SECRET`
  - `AUTH_GOOGLE_ID`
  - `AUTH_GOOGLE_SECRET`
  - `ADMIN_OWNER_EMAILS`
  - `RESEND_API_KEY`
  - `RESEND_WEBHOOK_SECRET`
  - `RESEND_SEGMENT_MARKETING_ID`
  - `FROM_EMAIL`
  - `ADMIN_EMAIL`
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
  - `GOOGLE_REDIRECT_URI`
  - `BOOKING_ADMIN_SETUP_SECRET`
  - `BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY`
  - `KV_REST_API_URL`
  - `KV_REST_API_TOKEN`
  - `SQUARE_ENVIRONMENT`
  - `SQUARE_ACCESS_TOKEN`
  - `SQUARE_APPLICATION_ID`
  - `SQUARE_LOCATION_ID`
  - `SQUARE_WEBHOOK_SIGNATURE_KEY`
  - `SQUARE_SERVICE_BOOKING_RETURN_URL`
  - `SQUARE_SERVICE_BOOKING_WEBHOOK_URL`
  - `SQUARE_COMMERCE_ENABLED`
  - `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED`
  - `SERVICE_BOOKING_SQUARE_ENABLED`
  - `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED`
  - `SERVICE_BOOKING_MODEL_MODE`
  - `CHECKOUT_SECRET_ENCRYPTION_KEY`
  - `PAYMENT_RECONCILIATION_CRON_SECRET`
  - `CRON_SECRET`
  - `DATABASE_URL`

This is not an exhaustive application environment list. Run `VERCEL_ENV=preview node scripts/validate-sanity-env.mjs` and `VERCEL_ENV=production node scripts/validate-sanity-env.mjs` with the corresponding environment loaded. The validator is authoritative only for the variables it checks; it does not currently validate every scheduled-job, backup-scaffold, or flat-rate-shipping variable. Cross-check `.env.local.example`, `vercel.json`, and `docs/scheduled-jobs-runbook.md` before deployment.

Do not put private tokens in `NEXT_PUBLIC_*` variables. `NEXT_PUBLIC_*` values are browser-visible. Checkout transaction history, customer PII, operational service-booking configuration, form/contact submissions, marketing contacts, and consent events must be stored in PostgreSQL, not Sanity. Sanity is public/editorial plus a historical submission backfill source. Use `docs/private-database-migration-runbook.md` for PostgreSQL schema changes and `docs/marketing-contact-privacy-compliance-follow-up.md` for retention/privacy operating decisions.

### Token Guardrails and Least Privilege

Sanity tokens must be managed with strict isolation and rotation policies. If plan constraints prevent granular custom roles, use the following guardrails:

| Token                   | Purpose                                         | Environment        | Min. Role | Owner  | Rotation  |
| :---------------------- | :---------------------------------------------- | :----------------- | :-------- | :----- | :-------- |
| `SANITY_API_READ_TOKEN` | Draft preview and Presentation Tool read access | Production/Staging | Viewer    | Dardan | Quarterly |
| `SANITY_WRITE_TOKEN`    | Server-side mutations and migrations            | Production/Staging | Editor    | Dardan | Quarterly |
| `SANITY_WEBHOOK_SECRET` | Webhook HMAC verification                       | Production/Staging | N/A       | Dardan | Quarterly |

**Rotation Policy:**

- Rotate all tokens quarterly.
- Rotate immediately after any suspected exposure.
- Rotate after personnel or access changes.
- Scoped tokens should be used in Vercel environment settings, never committed to the repository.

## Phase 1: Confirm Current Sanity State

From the repository root:

```bash
cd /Users/dardan/workspace/lash-her-frontend

npx sanity dataset list --project-id 3auncj84
```

Confirm that `staging-2026-05-10` exists as a normal dataset:

```bash
npx sanity dataset list --project-id 3auncj84
```

Check dataset visibility:

```bash
npx sanity dataset visibility get production --project-id 3auncj84
npx sanity dataset visibility get staging-2026-05-10 --project-id 3auncj84
```

Recommended staging visibility is usually `private` unless there is a specific reason for public read access.

## Phase 2: Refresh Staging Content From Production

### Preferred: Cloud Clone

If Sanity Cloud Clone is available for the project, use it. It is faster and more reliable than local export/import for larger datasets and assets.

Create a fresh staging clone:

```bash
npx sanity dataset copy production staging-2026-05-10 \
  --project-id 3auncj84 \
  --skip-history \
  --skip-content-releases
```

If the copy is long-running, run detached:

```bash
npx sanity dataset copy production staging-2026-05-10 \
  --project-id 3auncj84 \
  --skip-history \
  --skip-content-releases \
  --detach
```

Then attach to the job when needed:

```bash
npx sanity dataset copy --attach <jobId> --project-id 3auncj84
```

After the copy completes, use `staging-2026-05-10` directly in app, Studio, and CLI environment variables.

### Fallback: Export and Import

If Cloud Clone is unavailable, use a full tarball export/import. Tarballs are preferred because they include assets by default and preserve asset references.

Export production:

```bash
npx sanity dataset export production ./production-export.tar.gz \
  --project-id 3auncj84 \
  --overwrite
```

Create the timestamped staging dataset:

```bash
npx sanity dataset create staging-2026-05-10 \
  --project-id 3auncj84 \
  --visibility private
```

Import the production export into `staging-2026-05-10`:

```bash
npx sanity dataset import ./production-export.tar.gz staging-2026-05-10 \
  --project-id 3auncj84 \
  --replace
```

Use `staging-2026-05-10` directly in app, Studio, and CLI environment variables.

## Phase 3: Deploy the Current Schema to Staging

Because this repo defines schemas in code, production schemas should be treated as source-controlled code, not as content to pull from the Studio.

Deploy the source-controlled schema to `staging-2026-05-10`:

```bash
cd /Users/dardan/workspace/lash-her-frontend

NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84 \
NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10 \
NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24 \
npx sanity schema deploy --workspace default
```

Verify the deployed schema list:

```bash
NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84 \
NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10 \
NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24 \
npx sanity schema list
```

If using Sanity-hosted Studio for staging, deploy that Studio build to the staging host:

```bash
NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84 \
NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10 \
NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24 \
npx sanity deploy --url <staging-studio-host> --schema-required
```

If using the embedded Next.js Studio, deploy the staging Next/Vercel environment with `NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10`.

## Phase 4: Configure Staging App and Studio

For the staging deployment, configure these public Sanity variables:

```env
NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84
NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10
NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24
```

Configure staging-only private secrets separately:

```env
SANITY_WRITE_TOKEN=<staging-capable-write-token>
SANITY_API_READ_TOKEN=<staging-capable-read-token>
SANITY_WEBHOOK_SECRET=<staging-webhook-secret>
AUTH_SECRET=<staging-auth-secret>
AUTH_GOOGLE_ID=<staging-admin-oauth-client-id>
AUTH_GOOGLE_SECRET=<staging-admin-oauth-client-secret>
ADMIN_OWNER_EMAILS=<comma-separated-owner-emails>
GOOGLE_CLIENT_ID=<staging-google-client-id>
GOOGLE_CLIENT_SECRET=<staging-google-client-secret>
GOOGLE_REDIRECT_URI=<staging-google-redirect-uri>
BOOKING_ADMIN_SETUP_SECRET=<staging-admin-secret>
BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
KV_REST_API_URL=<staging-kv-rest-api-url>
KV_REST_API_TOKEN=<staging-kv-rest-api-token>
SQUARE_ENVIRONMENT=sandbox
SQUARE_ACCESS_TOKEN=<staging-square-access-token>
SQUARE_APPLICATION_ID=<staging-square-application-id>
SQUARE_LOCATION_ID=<staging-square-location-id>
SQUARE_WEBHOOK_SIGNATURE_KEY=<staging-square-webhook-signature-key>
SQUARE_SERVICE_BOOKING_RETURN_URL=https://<staging-domain>/api/booking/square/return
SQUARE_SERVICE_BOOKING_WEBHOOK_URL=https://<staging-domain>/api/webhooks/square
SQUARE_COMMERCE_ENABLED=<true-or-false>
TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=<true-or-false>
SERVICE_BOOKING_SQUARE_ENABLED=true
SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true
PAYMENT_GATEWAY_MODE=live
CHECKOUT_SECRET_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
SERVICE_BOOKING_MODEL_MODE=operational
PAYMENT_RECONCILIATION_CRON_SECRET=<staging-route-specific-secret>
CRON_SECRET=<staging-vercel-cron-secret>
DATABASE_URL=<staging-neon-pooled-postgres-url>
```

Current form/contact writes use the private database, not a Sanity form token.

If the embedded Studio or frontend is served from a custom staging domain, add that origin to Sanity CORS with credentials:

```bash
npx sanity cors add https://<staging-domain> \
  --credentials \
  --project-id 3auncj84
```

Also add local development origins if needed:

```bash
npx sanity cors add http://localhost:3000 \
  --credentials \
  --project-id 3auncj84
```

## Phase 5: Test Studio Changes in Staging

Run local validation from the repository root:

```bash
cd /Users/dardan/workspace/lash-her-frontend

npm run lint
npm run build
npm run test:unit
npm test
```

Then manually verify the actual staging surfaces:

- Open the staging app `/studio`.
- Confirm the Studio targets `staging-2026-05-10`, not production.
- Confirm production content appears in `staging-2026-05-10` after the refresh.
- Confirm new schema types and singleton entries appear as expected.
- Confirm `bookingSettings` is absent from the active Studio structure. If legacy documents of that type still exist in the dataset, do not edit or recreate them as current configuration.
- Create or update test documents in `staging-2026-05-10` only.
- Verify the public staging app reads the staged content correctly.
- Verify service-booking configuration separately through `/admin/setup`, `/admin/booking-settings`, `/admin/offerings`, `/admin/schedules`, and `/admin/calendar-connections`; those values are PostgreSQL-owned and are not promoted with a Sanity dataset.
- Verify forms, operational booking flows, webhook revalidation, and checkout paths using staging-only credentials.

## Phase 6: Promote Schema and Studio Changes to Production

Promote code through Git and CI, not by copying staging schema documents into production.

1. Complete and review the source changes.
2. Validate against staging.
3. Review and merge the branch into the production branch.
4. Deploy the production app/Studio with production environment variables.
5. Deploy the production schema representation:

```bash
cd /Users/dardan/workspace/lash-her-frontend

NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84 \
NEXT_PUBLIC_SANITY_DATASET=production \
NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24 \
SANITY_SCHEMA_DEPLOY_TARGET=production \
npx sanity schema deploy --workspace default
```

If using Sanity-hosted production Studio:

```bash
NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84 \
NEXT_PUBLIC_SANITY_DATASET=production \
NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24 \
npx sanity deploy --url <production-studio-host> --schema-required
```

If using the embedded Next.js Studio, deploy the production Next/Vercel app with:

```env
NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84
NEXT_PUBLIC_SANITY_DATASET=production
NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24
```

## Phase 7: Promote Content Changes Safely

Do not blindly import the full staging dataset into production unless the goal is to replace production content wholesale.

Recommended options, from safest to riskiest:

### Option A: Schema-Only Promotion

If the change only adds or modifies Studio/schema code, deploy code and schema only. No content import is required.

### Option B: Targeted Manual Production Edits

If only a small amount of production content is needed, create it manually in the production Studio after the schema deploy.

This is often the safest option for active singleton editorial documents such as `globalSettings` or `mainMenu`. Do not create a `bookingSettings` document; current service-booking configuration belongs in PostgreSQL and is managed through `/admin`.

### Option C: Targeted Migration Script

For structural changes or required default content, write a migration that patches known documents by ID/type. Run it against `staging-2026-05-10` first, then production.

Use this pattern for changes such as:

- Adding fields with default values.
- Renaming fields.
- Moving content between old and new shapes.
- Creating required singleton documents.

### Option D: Selected Type Export and Import

Use only when the changed document set is known and safe to replace.

Example:

```bash
npx sanity dataset export staging-2026-05-10 ./selected-content.tar.gz \
  --project-id 3auncj84 \
  --types service,product,productCollection,trainingProgram,policyPage

npx sanity dataset import ./selected-content.tar.gz production \
  --project-id 3auncj84 \
  --replace
```

Use `--replace` only when replacing documents with matching IDs is intentional.

### Option E: Full Staging-to-Production Dataset Import

Avoid this for normal releases.

This replaces broad production content with staging content and can overwrite production edits made after the staging refresh.

Only use this if production is intentionally frozen and everyone agrees staging is the complete source of truth:

```bash
npx sanity dataset export staging-2026-05-10 ./staging-export.tar.gz \
  --project-id 3auncj84 \
  --overwrite

npx sanity dataset import ./staging-export.tar.gz production \
  --project-id 3auncj84 \
  --replace
```

## Recommended Change to Make Before Heavy Staging Work

`sanity.cli.ts` reads `NEXT_PUBLIC_SANITY_DATASET` and refuses the production dataset unless the operator also sets `SANITY_SCHEMA_DEPLOY_TARGET=production`:

```ts
export default defineCliConfig({
  api: {
    projectId: "3auncj84",
    dataset: DATASET,
  },
});
```

Prefer explicit environment variables in release commands so the target dataset and production confirmation are visible in command history.

## Operational Guardrails

- Treat production-to-staging copy as a refresh operation.
- Treat staging-to-production as code promotion plus targeted content migration.
- Never expose Sanity write tokens, legacy/conditional form tokens, deploy tokens, Square access/webhook tokens, Google secrets, Upstash tokens, database credentials, or encryption keys in browser-visible variables.
- Before any production content import, export production as a backup tarball.
- Avoid deleting schema fields that contain production data. Deprecate, migrate, verify, then remove later.
- Keep singleton document IDs aligned with schema names and Studio structure.
- Keep loader projections and TypeScript types synchronized with schema changes.
- Treat any surviving `bookingSettings` document or legacy service commerce fields as V1 compatibility data, not as current operational configuration.
- Remember that schema deploy does not transform existing content.
- Remember that dataset copy/import does not deploy Studio code.

## Suggested Release Checklist

Before staging refresh:

- [ ] Confirm production dataset is `production`.
- [ ] Confirm staging dataset is `staging-2026-05-10`.
- [ ] Confirm Sanity permissions and token availability.
- [ ] Confirm staging secrets are separate from production secrets.

After staging refresh:

- [ ] Confirm `staging-2026-05-10` contains the fresh production copy.
- [ ] Confirm staging Studio targets `staging-2026-05-10`.
- [ ] Confirm production content appears in `staging-2026-05-10`.
- [ ] Deploy the current source-controlled schema to `staging-2026-05-10`.

Before production release:

- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] Run `npm run test:unit`.
- [ ] Run `npm test`.
- [ ] Run the target environment through `scripts/validate-sanity-env.mjs`.
- [ ] Run `npm run db:check` against the verified PostgreSQL target when the release includes private-data or operational-booking changes.
- [ ] Manually verify staging `/studio`.
- [ ] Manually verify public staging pages and flows affected by the schema changes.
- [ ] Decide whether production needs schema-only promotion, manual content edits, targeted migration, or selected document import.
- [ ] Back up production dataset before any production content import.

Production release:

- [ ] Merge reviewed code.
- [ ] Deploy production app/Studio with production Sanity env.
- [ ] Deploy production schema representation.
- [ ] Run any approved targeted content migration.
- [ ] Verify production Studio.
- [ ] Verify production public pages and affected flows.

## Phase 8: Pre-Launch Content Audit

Before promoting to production, run a GROQ audit to ensure all checkout-enabled training programs have valid native commerce fields.

### Training Checkout Audit Query

Run this query in the Sanity Vision tool or via CLI with the published perspective to find invalid launch configurations. It mirrors the Studio and runtime training checkout guardrails that are authored in Sanity: checkout is enabled, native price is positive, and availability has been explicitly set. Currency is not a Sanity field for training programs; `src/data/loaders.ts` projects the runtime value as `CAD`.

```groq
*[
  _type == "trainingProgram" &&
  !(_id in path("drafts.**")) &&
  checkoutEnabled == true &&
  (
    !defined(price) ||
    price <= 0 ||
    !defined(isAvailable)
  )
] {
  _id,
  title,
  price,
  isAvailable,
  "issue": select(
    !defined(price) || price <= 0 => "native training price is missing or not positive",
    !defined(isAvailable) => "native training availability is not set",
    "unknown invalid checkout configuration"
  )
}
```

**Expected Result:** Zero published documents returned. If any documents appear, they must be corrected in the Studio before launch. Running the same query without the draft exclusion in the raw perspective is useful for cleanup, but draft-only hits are not launch blockers unless they are published.

## Phase 9: Studio Launch Verification

Verify the Studio environment and structure before declaring production readiness.

### Environment and Schema

- [ ] **Target Dataset:** Confirm `NEXT_PUBLIC_SANITY_DATASET` matches the intended environment (`production` or `staging-2026-05-10`).
- [ ] **Deployed Schema:** Run `npx sanity schema list` and verify it matches the current source-controlled schema.
- [ ] **Embedded Studio:** Confirm `/studio` loads correctly on the target domain.

### Structure and Security

- [ ] **Singleton Integrity:** Verify `homePage`, `contactPage`, `galleryPage`, `trainingPage`, `trainingProgramsPage`, `productsPage`, `globalSettings`, and `mainMenu` appear as singletons in the Studio sidebar.
- [ ] **Legacy Booking Isolation:** Verify `bookingSettings` does not appear in the Studio sidebar and that service-booking operations use PostgreSQL-backed Admin pages.
- [ ] **PII Isolation:** Confirm that checkout orders, payment events, provider transaction references, operational appointments, and customer PII are NOT visible in the Studio. These must remain in PostgreSQL.
- [ ] **Token Scoping:** Verify that the Studio does not expose any private tokens in the browser console or network tab.

## Phase 10: Webhook Configuration and Operations

The application uses signed Sanity webhooks to trigger immediate Next.js cache revalidation. Route fallbacks are not uniform: some editorial routes use 1,800 seconds, product and service detail routes use 300 seconds, and operational service listing/booking routes are dynamic. Treat a successful signed webhook as the launch requirement rather than relying on a fixed ISR interval.

### Webhook Configuration

Configure separate webhooks for staging and production in the Sanity project management panel.

| Setting    | Staging Value                                                                                                                                                                                                                            | Production Value                                     |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------- |
| URL        | `https://staging.lashher.com/api/revalidate`                                                                                                                                                                                             | `https://www.lashher.com/api/revalidate`             |
| Project    | `3auncj84`                                                                                                                                                                                                                               | `3auncj84`                                           |
| Dataset    | `staging-2026-05-10`                                                                                                                                                                                                                     | `production`                                         |
| Trigger    | Published document create, update, and delete events                                                                                                                                                                                     | Published document create, update, and delete events |
| Filter     | `_type in ["homePage", "contactPage", "galleryPage", "trainingPage", "trainingProgramsPage", "trainingProgram", "productsPage", "productCollection", "promotionCode", "policyPage", "product", "service", "globalSettings", "mainMenu"]` | Same as staging                                      |
| Projection | `{ _id, _type }`                                                                                                                                                                                                                         | `{ _id, _type }`                                     |
| Method     | `POST`                                                                                                                                                                                                                                   | `POST`                                               |
| Secret     | Staging `SANITY_WEBHOOK_SECRET`                                                                                                                                                                                                          | Production `SANITY_WEBHOOK_SECRET`                   |

Keep staging and production secrets separate. The Sanity webhook secret must exactly match the corresponding Vercel environment value for the target deployment.

Drafts and release versions should not be used for launch smoke evidence. Smoke tests must publish the live document version in the matching dataset so the webhook reflects the same content the public app reads.

### Tag Map and No-Op Rationale

The revalidation route maps Sanity `_type` values to Next.js cache tags. Loader tags in `src/data/loaders.ts` and `TYPE_TAG_MAP` in `src/app/api/revalidate/handler.ts` must be updated together when a public cached document type is added.

| Sanity `_type`         | Cache tag              | Public impact                                                                        |
| :--------------------- | :--------------------- | :----------------------------------------------------------------------------------- |
| `homePage`             | `homePage`             | `/`                                                                                  |
| `contactPage`          | `contactPage`          | `/contact`                                                                           |
| `galleryPage`          | `galleryPage`          | `/gallery`                                                                           |
| `trainingPage`         | `trainingPage`         | Retained content model; `/training` currently redirects to `/training-programs`      |
| `trainingProgramsPage` | `trainingProgramsPage` | `/training-programs` page composition                                                |
| `trainingProgram`      | `trainingProgram`      | Home/program cards, `/training-programs/[slug]`, and training checkout reads         |
| `productsPage`         | `productsPage`         | `/products` editorial shell                                                          |
| `productCollection`    | `productCollection`    | `/products` featured collections and catalog grouping                                |
| `promotionCode`        | `promotionCode`        | Product and training promotion validation reads                                      |
| `policyPage`           | `policyPage`           | `/policies/[slug]` and checkout policy reads                                         |
| `product`              | `product`              | `/products`, `/products/[slug]`, checkout reads, and stock set-point synchronization |
| `service`              | `service`              | `/services/[slug]` editorial/media/SEO; not operational booking configuration        |
| `globalSettings`       | `global`               | Header, footer, popup, and metadata                                                  |
| `mainMenu`             | `menu`                 | Navigation                                                                           |

Unknown document types intentionally return 200 without revalidating a tag. Legacy submission or internal tracking types such as `contactForm`, `generalInquiry`, `contactPopupSubmission`, and `bookingMarketingOptIn` do not drive cached public page rendering, so they are documented no-ops rather than hard failures. Current live form/contact/marketing writes go to PostgreSQL, not Sanity.

`TYPE_TAG_MAP` retains `bookingSettings` only so a legacy V1 document event can invalidate the compatibility loader during migration or historical payment reconciliation. It is not an active schema type, must not be included in the current webhook filter, and does not configure operational service booking.

### Product Inventory Synchronization

The general `/api/revalidate` handler uses a product event's `_id` to run the Sanity stock set-point synchronization after returning the cache-revalidation response. This is why the projection must be `{ _id, _type }`, not `{ _type }`.

A dedicated signed endpoint also exists at `/api/webhooks/sanity/inventory-sync` for deployments that intentionally separate stock delivery from cache revalidation. Configure it with the same environment-specific `SANITY_WEBHOOK_SECRET` and these values:

| Setting    | Value                                                |
| :--------- | :--------------------------------------------------- |
| Trigger    | Published document create, update, and delete events |
| Filter     | `_type == "product"`                                 |
| Projection | `{ _id, _type }`                                     |
| Method     | `POST`                                               |

The dedicated handler returns `400` when a product `_id` is absent and `500` when the PostgreSQL synchronization fails. The general revalidation handler treats stock synchronization as an after-response side effect so a database error does not prevent cache invalidation. Decide which delivery path is operationally monitored; both use the same idempotent stock set-point reconciliation.

### Smoke Testing

Run this once in staging before launch and schedule production for a controlled launch window.

1. Confirm the target deployment has the expected `NEXT_PUBLIC_SANITY_DATASET` and `SANITY_WEBHOOK_SECRET`.
2. Publish a safe visible edit in the matching Studio dataset.
3. Confirm Sanity reports a successful delivery to `/api/revalidate`.
4. Check Vercel runtime logs for the expected `[revalidate] tag='<tag>' _type='<type>'` entry and HTTP 200.
5. Refresh the mapped public page and record before/after evidence.
6. Revert or clean up the smoke edit if it was only for testing.

### Operational Response and Backfill

Watch Vercel logs for `/api/revalidate` during launch.

- `401`: `SANITY_WEBHOOK_SECRET` is missing or mismatched. Verify the Vercel secret and Sanity webhook secret for the same environment.
- `400`: The webhook projection is missing `_type`; the dedicated inventory endpoint also requires a product `_id`. Verify the projection is `{ _id, _type }`.
- `5xx`: The route crashed. Check route logs and do not proceed with production content publishing until resolved.
- Repeated failures: Sanity retries are still failing. Pause publishes and fix the route or environment before continuing.
- Stale content after 200: Verify the `_type` maps to the cache tag used by the affected loader.

If a webhook is missed, re-publish the affected mapped document in Sanity to trigger a new delivery. For bulk updates, publish a safe edit to each affected mapped document type. Do not treat a universal 30-minute timeout as a recovery control because route caching varies and operational service pages are dynamic.

## Phase 11: Launch Readiness and Smoke Testing

Before declaring a release ready for production, you must complete the launch readiness checklist. This ensures that all environment variables are correct and that content revalidation is working as expected.

Refer to [Launch Readiness Checklist](./launch-readiness-checklist.md) for the full smoke matrix and evidence requirements.

### CMS Smoke Summary

- **Verify Publish Flow:** Update a document in the Studio, publish it, and confirm the change appears on the public site.
- **Check Webhooks:** Ensure the Sanity webhook delivers a signed payload to `/api/revalidate`.
- **Validate Cache Tags:** Confirm the correct cache tags are being invalidated for each document type.

### Stop Conditions

Production promotion must stop if:

- A production publish does not appear on the public page after webhook delivery.
- The webhook targets the wrong dataset or cache tag.
- Environment validation fails for any production-critical secret.
