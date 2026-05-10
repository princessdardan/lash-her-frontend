# Sanity Staging and Production Workflow

This document describes how to use one Sanity project with separate Lash Her `production` and `staging` datasets to test Studio/schema/content changes, then safely promote completed work to production.

## Architecture Decision

Lash Her will use a single Sanity project, `3auncj84`, with two named datasets:

- Production content lives in the `production` dataset.
- Staging content lives in the `staging` dataset.
- Refreshing staging means replacing the contents of the existing `staging` dataset with a fresh copy of `production` content.
- Promotion to production means promoting code/schema through Git and deployment, plus targeted production content edits or migrations when needed.

This gives us isolated content and schema deployment targets while keeping project-level Sanity settings shared. It is not the same as hard project isolation: members, project-level tokens, CORS origins, webhooks, quotas, and project administration remain shared under `3auncj84`.

The implementation worktree for this effort is:

```bash
/Users/dardan/Documents/lash-her-booking-helcim-integration
```

Run frontend and Sanity commands from:

```bash
cd /Users/dardan/Documents/lash-her-booking-helcim-integration/frontend
```

## Current Project Findings

- The active application is the `frontend` Next.js app.
- The Sanity Studio is embedded at `/studio` through `frontend/src/app/studio/[[...tool]]/page.tsx`.
- Studio configuration lives in `frontend/src/sanity/sanity.config.ts`.
- Schemas are code-defined and manually registered in `frontend/src/sanity/schemas/index.ts`.
- Runtime Sanity targeting is environment-driven through `frontend/src/sanity/env.ts`:
  - `NEXT_PUBLIC_SANITY_PROJECT_ID`
  - `NEXT_PUBLIC_SANITY_DATASET`
  - `NEXT_PUBLIC_SANITY_API_VERSION`
- Staging and production use the same `NEXT_PUBLIC_SANITY_PROJECT_ID` and switch environments by changing `NEXT_PUBLIC_SANITY_DATASET`.
- The Sanity project ID found in `frontend/sanity.cli.ts` is `3auncj84`.
- `frontend/sanity.cli.ts` currently hardcodes the CLI dataset to `production`.
- The implementation worktree already contains booking/Helcim schema additions, including `bookingSettings` as a singleton.

Important distinction: the Sanity Studio does not contain the content. The Studio is the editing application and schema code. Content lives in a Sanity Content Lake dataset. Copying production into staging means copying the production dataset into a staging dataset; deploying Studio/schema code is a separate step.

## Recommended Environment Names

Use these names unless project `3auncj84` already has different dataset conventions:

- Shared Sanity project: `3auncj84`
- Production dataset: `production`
- Staging dataset: `staging`

The app and Studio should always target the dataset name for their environment: `production` for production and `staging` for staging.

## Required Access and Secrets

Before proceeding, confirm you have:

- Sanity CLI access to project `3auncj84` with permission to manage datasets and deploy schemas.
- A Sanity token for CI/unattended commands, exposed only as `SANITY_AUTH_TOKEN` when needed.
- Separate staging and production values for dataset-specific/runtime settings:
  - `NEXT_PUBLIC_SANITY_PROJECT_ID` (same value, `3auncj84`, for both staging and production)
  - `NEXT_PUBLIC_SANITY_DATASET`
  - `NEXT_PUBLIC_SANITY_API_VERSION`
  - `SANITY_WRITE_TOKEN`
  - `SANITY_FORM_TOKEN`
  - `SANITY_WEBHOOK_SECRET`
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
  - `GOOGLE_REDIRECT_URI`
  - `BOOKING_ADMIN_SETUP_SECRET`
  - `KV_REST_API_URL`
  - `KV_REST_API_TOKEN`
  - `HELCIM_API_TOKEN`
  - `CHECKOUT_SECRET_ENCRYPTION_KEY`

Do not put private tokens in `NEXT_PUBLIC_*` variables. `NEXT_PUBLIC_*` values are browser-visible.

Because staging and production share one Sanity project, keep staging-only app secrets separate in the hosting environment even when the Sanity project ID is the same.

## Phase 1: Confirm Current Sanity State

From the implementation worktree frontend directory:

```bash
cd /Users/dardan/Documents/lash-her-booking-helcim-integration/frontend

npx sanity datasets list --project-id 3auncj84
```

Confirm the `staging` dataset exists. It is a normal dataset, not the alias target used by this workflow.

Check dataset visibility:

```bash
npx sanity datasets visibility get production --project-id 3auncj84
npx sanity datasets visibility get staging --project-id 3auncj84
```

Recommended staging visibility is usually `private` unless there is a specific reason for public read access.

## Phase 2: Refresh Staging Content From Production

Because `staging` is an existing dataset name, refresh it with export/import. Sanity Cloud Clone creates a new target dataset and is better suited to alias-based workflows; do not rely on it to overwrite the existing `staging` dataset directly.

First, export the current staging dataset as a rollback backup:

```bash
npx sanity datasets export staging ./staging-backup-before-refresh.tar.gz \
  --project-id 3auncj84 \
  --overwrite
```

Then export production. Tarballs are preferred because they include assets by default and preserve asset references.

Export production:

```bash
npx sanity datasets export production ./production-export.tar.gz \
  --project-id 3auncj84 \
  --overwrite
```

Import the production export into the existing `staging` dataset:

```bash
npx sanity datasets import ./production-export.tar.gz staging \
  --project-id 3auncj84 \
  --replace
```

The `--replace` flag intentionally replaces documents with matching IDs in `staging` so staging mirrors the exported production content. Treat any staging-only content as disposable before running this refresh.

## Phase 3: Deploy the Current Schema to Staging

Because this repo defines schemas in code, production schemas should be treated as source-controlled code, not as content to pull from the Studio.

Deploy the worktree schema to the staging dataset:

```bash
cd /Users/dardan/Documents/lash-her-booking-helcim-integration/frontend

NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84 \
NEXT_PUBLIC_SANITY_DATASET=staging \
NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24 \
npx sanity schemas deploy --workspace default
```

Verify the deployed schema list:

```bash
NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84 \
NEXT_PUBLIC_SANITY_DATASET=staging \
NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24 \
npx sanity schemas list
```

If using Sanity-hosted Studio for staging, deploy that Studio build to the staging host:

```bash
NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84 \
NEXT_PUBLIC_SANITY_DATASET=staging \
NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24 \
npx sanity deploy --url <staging-studio-host> --schema-required
```

If using the embedded Next.js Studio, deploy the staging Next/Vercel environment with `NEXT_PUBLIC_SANITY_DATASET=staging`.

## Phase 4: Configure Staging App and Studio

For the staging deployment, configure these public Sanity variables:

```env
NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84
NEXT_PUBLIC_SANITY_DATASET=staging
NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24
```

Configure staging-only private secrets separately:

```env
SANITY_WRITE_TOKEN=<staging-capable-write-token>
SANITY_FORM_TOKEN=<staging-capable-form-token>
SANITY_WEBHOOK_SECRET=<staging-webhook-secret>
GOOGLE_CLIENT_ID=<staging-google-client-id>
GOOGLE_CLIENT_SECRET=<staging-google-client-secret>
GOOGLE_REDIRECT_URI=<staging-google-redirect-uri>
BOOKING_ADMIN_SETUP_SECRET=<staging-admin-secret>
KV_REST_API_URL=<staging-kv-rest-api-url>
KV_REST_API_TOKEN=<staging-kv-rest-api-token>
HELCIM_API_TOKEN=<staging-helcim-token>
CHECKOUT_SECRET_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
```

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

Run local validation from the implementation worktree:

```bash
cd /Users/dardan/Documents/lash-her-booking-helcim-integration/frontend

npm run lint
npm run build
npm test
```

Then manually verify the actual staging surfaces:

- Open the staging app `/studio`.
- Confirm the Studio targets the staging dataset, not production.
- Confirm production content appears in staging after the refresh.
- Confirm new schema types and singleton entries appear as expected.
- For booking work, confirm `bookingSettings` is visible and behaves as a singleton.
- Create or update test documents in staging only.
- Verify the public staging app reads the staged content correctly.
- Verify forms, booking flows, webhook revalidation, and checkout paths using staging-only credentials.

## Phase 6: Promote Schema and Studio Changes to Production

Promote code through Git and CI, not by copying staging schema documents into production.

1. Complete implementation in the worktree.
2. Validate against staging.
3. Review and merge the branch into the production branch.
4. Deploy the production app/Studio with production environment variables.
5. Deploy the production schema representation:

```bash
cd /Users/dardan/Documents/lash-her-booking-helcim-integration/frontend

NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84 \
NEXT_PUBLIC_SANITY_DATASET=production \
NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24 \
npx sanity schemas deploy --workspace default
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

For structural changes or required default content, write a migration that patches known documents by ID/type. Run it against staging first, then production.

Use this pattern for changes such as:

- Adding fields with default values.
- Renaming fields.
- Moving content between old and new shapes.
- Creating required singleton documents.

### Option D: Selected Type Export and Import

Use only when the changed document set is known and safe to replace.

Example:

```bash
npx sanity datasets export staging ./booking-content.tar.gz \
  --project-id 3auncj84 \
  --types bookingSettings,sellableProduct

npx sanity datasets import ./booking-content.tar.gz production \
  --project-id 3auncj84 \
  --replace
```

Use `--replace` only when replacing documents with matching IDs is intentional.

### Option E: Full Staging-to-Production Dataset Import

Avoid this for normal releases.

This replaces broad production content with staging content and can overwrite production edits made after the staging refresh.

Only use this if production is intentionally frozen and everyone agrees staging is the complete source of truth:

```bash
npx sanity datasets export staging ./staging-export.tar.gz \
  --project-id 3auncj84 \
  --overwrite

npx sanity datasets import ./staging-export.tar.gz production \
  --project-id 3auncj84 \
  --replace
```

## Recommended Change to Make Before Heavy Staging Work

`frontend/sanity.cli.ts` currently points CLI operations at `production` by default:

```ts
export default defineCliConfig({
  api: {
    projectId: "3auncj84",
    dataset: "production",
  },
});
```

This is risky because a missed flag can operate on production.

Recommended update:

```ts
import { defineCliConfig } from "sanity/cli";

export default defineCliConfig({
  api: {
    projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || "3auncj84",
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET || "production",
  },
});
```

Even after this change, prefer explicit environment variables in release commands so the target dataset is visible in command history.

## Operational Guardrails

- Treat production-to-staging copy as a refresh operation.
- Treat staging-to-production as code promotion plus targeted content migration.
- Treat `production` and `staging` as separate datasets inside the same Sanity project, not as separate Sanity projects.
- Remember that project-level Sanity settings are shared across both datasets.
- Never expose Sanity write tokens, form tokens, deploy tokens, Helcim tokens, Google secrets, Upstash tokens, or encryption keys in browser-visible variables.
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
- [ ] Confirm staging dataset is named `staging` inside project `3auncj84`.
- [ ] Confirm Sanity permissions and token availability.
- [ ] Confirm staging app secrets are separate from production app secrets even though both use project `3auncj84`.

After staging refresh:

- [ ] Confirm `staging` contains the fresh production copy.
- [ ] Confirm staging Studio targets `staging`.
- [ ] Confirm production content appears in staging.
- [ ] Deploy current worktree schema to staging.

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
