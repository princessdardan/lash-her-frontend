# Sanity Staging and Production Workflow


## Canonical Git and Vercel Branch Target

The Vercel staging subdomain must target the `staging` branch in the frontend repository:

```text
https://github.com/princessdardan/lash-her-frontend
```

Do not create or push deployment branches to `https://github.com/princessdardan/lash-her`. In local checkouts, verify remotes with `git remote -v` before pushing. This workspace may contain a legacy or planning remote named `origin`; use the `frontend` remote or run from `frontend`:

```bash
npm run git:push-staging
```

This document describes how to use the Lash Her staging Sanity Studio and staging dataset to test Studio/schema/content changes, then safely promote completed work to production.

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
- The Sanity project ID found in `frontend/sanity.cli.ts` is `3auncj84`.
- `frontend/sanity.cli.ts` currently hardcodes the CLI dataset to `production`.
- The implementation worktree already contains booking/Helcim schema additions, including `bookingSettings` as a singleton.

Important distinction: the Sanity Studio does not contain the content. The Studio is the editing application and schema code. Content lives in a Sanity Content Lake dataset. Copying production into staging means copying the production dataset into a staging dataset; deploying Studio/schema code is a separate step.

## Recommended Environment Names

Use these names unless the Sanity project already has different conventions:

- Sanity project: `3auncj84`
- Production dataset: `production`
- Stable staging dataset alias: `staging`
- Timestamped staging dataset clone: `staging-YYYY-MM-DD`, for example `staging-2026-05-10`

Using a stable alias named `staging` gives the app and Studio a permanent dataset name while allowing safe refreshes from production by cloning into a new timestamped dataset and relinking the alias.

## Required Access and Secrets

Before proceeding, confirm you have:

- Sanity CLI access to project `3auncj84` with permission to manage datasets and deploy schemas.
- A Sanity token for CI/unattended commands, exposed only as `SANITY_AUTH_TOKEN` when needed.
- Separate staging and production values for:
  - `NEXT_PUBLIC_SANITY_PROJECT_ID`
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

## Phase 1: Confirm Current Sanity State

From the implementation worktree frontend directory:

```bash
cd /Users/dardan/Documents/lash-her-booking-helcim-integration/frontend

npx sanity dataset list --project-id 3auncj84
```

Confirm whether `staging` is a dataset or a dataset alias:

```bash
npx sanity dataset alias list --project-id 3auncj84
```

Check dataset visibility:

```bash
npx sanity dataset visibility get production --project-id 3auncj84
npx sanity dataset visibility get staging --project-id 3auncj84
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

After the copy completes, point the stable staging alias to the new clone.

If the alias does not exist yet:

```bash
npx sanity dataset alias create staging staging-2026-05-10 --project-id 3auncj84
```

If the alias already exists:

```bash
npx sanity dataset alias link staging staging-2026-05-10 \
  --project-id 3auncj84 \
  --force
```

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

Import the production export into staging:

```bash
npx sanity dataset import ./production-export.tar.gz staging-2026-05-10 \
  --project-id 3auncj84 \
  --replace
```

Point the stable alias at the imported dataset:

```bash
npx sanity dataset alias link staging staging-2026-05-10 \
  --project-id 3auncj84 \
  --force
```

## Phase 3: Deploy the Current Schema to Staging

Because this repo defines schemas in code, production schemas should be treated as source-controlled code, not as content to pull from the Studio.

Deploy the worktree schema to the staging dataset:

```bash
cd /Users/dardan/Documents/lash-her-booking-helcim-integration/frontend

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
npx sanity dataset export staging ./booking-content.tar.gz \
  --project-id 3auncj84 \
  --types bookingSettings,sellableProduct

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
npx sanity dataset export staging ./staging-export.tar.gz \
  --project-id 3auncj84 \
  --overwrite

npx sanity dataset import ./staging-export.tar.gz production \
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
- [ ] Confirm staging alias/dataset strategy.
- [ ] Confirm Sanity permissions and token availability.
- [ ] Confirm staging secrets are separate from production secrets.

After staging refresh:

- [ ] Confirm `staging` points to the fresh production copy.
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
