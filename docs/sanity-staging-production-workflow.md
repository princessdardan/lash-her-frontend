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
- The source schema includes booking, commerce, and private-data boundary types, including `bookingSettings` as a singleton.

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
  - `RESEND_API_KEY`
  - `FROM_EMAIL`
  - `ADMIN_EMAIL`
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
  - `GOOGLE_REDIRECT_URI`
  - `BOOKING_ADMIN_SETUP_SECRET`
  - `KV_REST_API_URL`
  - `KV_REST_API_TOKEN`
  - `HELCIM_GENERAL_API_TOKEN`
  - `HELCIM_TRANSACTION_API_TOKEN`
  - `HELCIM_WEBHOOK_VERIFIER_TOKEN`
  - `CHECKOUT_SECRET_ENCRYPTION_KEY`
  - `DATABASE_URL`

Do not put private tokens in `NEXT_PUBLIC_*` variables. `NEXT_PUBLIC_*` values are browser-visible. Checkout transaction history, customer PII, form/contact submissions, marketing contacts, and consent events must be stored in the private database, not Sanity. Sanity is public/editorial plus historical submission backfill source. Use `docs/private-database-migration-runbook.md` for schema changes and `docs/marketing-contact-privacy-compliance-follow-up.md` for retention/privacy operating decisions.

### Token Guardrails and Least Privilege

Sanity tokens must be managed with strict isolation and rotation policies. If plan constraints prevent granular custom roles, use the following guardrails:

| Token | Purpose | Environment | Min. Role | Owner | Rotation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `SANITY_API_READ_TOKEN` | Draft preview and Presentation Tool read access | Production/Staging | Viewer | Dardan | Quarterly |
| `SANITY_WRITE_TOKEN` | Server-side mutations and migrations | Production/Staging | Editor | Dardan | Quarterly |
| `SANITY_WEBHOOK_SECRET` | Webhook HMAC verification | Production/Staging | N/A | Dardan | Quarterly |

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
GOOGLE_CLIENT_ID=<staging-google-client-id>
GOOGLE_CLIENT_SECRET=<staging-google-client-secret>
GOOGLE_REDIRECT_URI=<staging-google-redirect-uri>
BOOKING_ADMIN_SETUP_SECRET=<staging-admin-secret>
KV_REST_API_URL=<staging-kv-rest-api-url>
KV_REST_API_TOKEN=<staging-kv-rest-api-token>
HELCIM_GENERAL_API_TOKEN=<staging-helcim-general-token>
HELCIM_TRANSACTION_API_TOKEN=<staging-helcim-transaction-token>
CHECKOUT_SECRET_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
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
npm test
```

Then manually verify the actual staging surfaces:

- Open the staging app `/studio`.
- Confirm the Studio targets `staging-2026-05-10`, not production.
- Confirm production content appears in `staging-2026-05-10` after the refresh.
- Confirm new schema types and singleton entries appear as expected.
- For booking work, confirm `bookingSettings` is visible and behaves as a singleton.
- Create or update test documents in `staging-2026-05-10` only.
- Verify the public staging app reads the staged content correctly.
- Verify forms, booking flows, webhook revalidation, and checkout paths using staging-only credentials.

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

This is often the safest option for singleton configuration like `bookingSettings`.

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
npx sanity dataset export staging-2026-05-10 ./booking-content.tar.gz \
  --project-id 3auncj84 \
  --types bookingSettings,service,product,trainingProgram

npx sanity dataset import ./booking-content.tar.gz production \
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
- Never expose Sanity write tokens, legacy/conditional form tokens, deploy tokens, Helcim tokens, Google secrets, Upstash tokens, database credentials, or encryption keys in browser-visible variables.
- Do not run the legacy `npm run migrate` script casually; it is a Strapi-to-Sanity migration path, not a staging refresh tool.
- Before any production content import, export production as a backup tarball.
- Avoid deleting schema fields that contain production data. Deprecate, migrate, verify, then remove later.
- Keep singleton document IDs aligned with schema names and Studio structure.
- Keep loader projections and TypeScript types synchronized with schema changes.
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
- [ ] Run `npm test`.
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

Run this query in the Sanity Vision tool or via CLI with the published perspective to find invalid launch configurations. It mirrors the Studio and runtime training checkout guardrails where content can be audited: checkout is enabled, native price is positive, currency is `CAD`, and availability has been explicitly set.

```groq
*[
  _type == "trainingProgram" &&
  !(_id in path("drafts.**")) &&
  checkoutEnabled == true &&
  (
    !defined(price) ||
    price <= 0 ||
    currency != "CAD" ||
    !defined(isAvailable)
  )
] {
  _id,
  title,
  price,
  currency,
  isAvailable,
  "issue": select(
    !defined(price) || price <= 0 => "native training price is missing or not positive",
    currency != "CAD" => "native training currency is not CAD",
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
- [ ] **Singleton Integrity:** Verify `homePage`, `globalSettings`, `mainMenu`, and `bookingSettings` appear as singletons in the Studio sidebar.
- [ ] **PII Isolation:** Confirm that checkout orders, payment events, Helcim references, and customer PII are NOT visible in the Studio. These must remain in the private database.
- [ ] **Token Scoping:** Verify that the Studio does not expose any private tokens in the browser console or network tab.

## Phase 10: Webhook Configuration and Operations

The application uses signed Sanity webhooks to trigger immediate Next.js cache revalidation. This lets published Studio changes appear on the public site without waiting for the 30-minute ISR background refresh.

### Webhook Configuration

Configure separate webhooks for staging and production in the Sanity project management panel.

| Setting | Staging Value | Production Value |
| :--- | :--- | :--- |
| URL | `https://staging.lashher.com/api/revalidate` | `https://www.lashher.com/api/revalidate` |
| Project | `3auncj84` | `3auncj84` |
| Dataset | `staging-2026-05-10` | `production` |
| Trigger | Published document create, update, and delete events | Published document create, update, and delete events |
| Filter | `_type in ["homePage", "contactPage", "galleryPage", "trainingPage", "trainingProgramsPage", "trainingProgram", "product", "service", "globalSettings", "mainMenu", "bookingSettings"]` | Same as staging |
| Projection | `{ _type }` | `{ _type }` |
| Method | `POST` | `POST` |
| Secret | Staging `SANITY_WEBHOOK_SECRET` | Production `SANITY_WEBHOOK_SECRET` |

Keep staging and production secrets separate. The Sanity webhook secret must exactly match the corresponding Vercel environment value for the target deployment.

Drafts and release versions should not be used for launch smoke evidence. Smoke tests must publish the live document version in the matching dataset so the webhook reflects the same content the public app reads.

### Tag Map and No-Op Rationale

The revalidation route maps Sanity `_type` values to Next.js cache tags. Loader tags in `src/data/loaders.ts` and the route map in `src/app/api/revalidate/route.ts` must be updated together when a public cached document type is added.

| Sanity `_type` | Cache tag | Public impact |
| :--- | :--- | :--- |
| `homePage` | `homePage` | `/` |
| `contactPage` | `contactPage` | `/contact` |
| `galleryPage` | `galleryPage` | `/gallery` |
| `trainingProgramsPage` | `trainingProgramsPage`, `trainingProgram` | `/training-programs` and training program cards (`/training` redirects here) |
| `trainingProgram` | `trainingProgram` | `/training-programs/[slug]` and native training checkout reads |
| `product` | `product` | `/products`, `/products/[slug]`, and canonical product checkout reads |
| `service` | `service` | `/services`, `/services/[slug]`, `/booking`, and paid appointment checkout configuration |
| `globalSettings` | `global` | Header, footer, metadata |
| `mainMenu` | `menu` | Navigation |
| `bookingSettings` | `bookingSettings` | `/booking` availability configuration |

Unknown document types intentionally return 200 without revalidating a tag. Legacy submission or internal tracking types such as `contactForm`, `generalInquiry`, `contactPopupSubmission`, and `bookingMarketingOptIn` do not drive cached public page rendering, so they are documented no-ops rather than hard failures. Current live form/contact/marketing writes should go to the private database, not Sanity.

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
- `400`: The webhook projection is missing `_type`. Verify the projection is exactly `{ _type }`.
- `5xx`: The route crashed. Check route logs and do not proceed with production content publishing until resolved.
- Repeated failures: Sanity retries are still failing. Pause publishes and fix the route or environment before continuing.
- Stale content after 200: Verify the `_type` maps to the cache tag used by the affected loader.

If a webhook is missed, re-publish the affected mapped document in Sanity to trigger a new delivery. For bulk updates, publish a safe edit to each affected mapped document type or wait for the 30-minute ISR timeout.

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
