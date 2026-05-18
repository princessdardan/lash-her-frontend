# CLAUDE.md

## Project Overview

Lash Her by Nataliea — a beauty/lash artistry business site. Root-level Next.js app with legacy Strapi migration context only (`/backend` is not present in this checkout).

## Commands

All app commands run from the repository root:

```bash
npm run dev          # Next.js dev server on :3000
npm run build        # Production build
npm run lint         # ESLint
npm test             # Playwright E2E (all browsers)
npx playwright test tests/homepage.spec.ts   # Single file; also supports --project=chromium, --headed, --debug
```

## Architecture

### Stack
- **Next.js 16** (App Router, React 18, React Compiler enabled)
- **Sanity v4** — public/editorial CMS and historical submission backfill source
- **PostgreSQL/Drizzle** — shared private PII storage for forms, marketing/contact, consent, checkout, payment events, and training enrollments
- **Tailwind CSS v4** with Radix UI primitives
- **Motion** for animations
- **Resend** for transactional email
- **Playwright** for E2E testing
- **Deployed on Vercel**

### Data Flow
Pages are async server components. All data from Sanity via GROQ queries:
1. `data/loaders.ts` — GROQ query functions, typed with interfaces from `types/index.ts`
2. Pages call loaders in parallel via `Promise.all` to avoid waterfalls
3. Global data (header/footer/menu) cached via `unstable_cache` with 1-hour TTL in `(site)/layout.tsx`
4. Home page uses ISR with 30-minute revalidation

### Block System
Pages are composed of CMS-driven layout blocks. Pipeline per block:
- **Sanity schema** (`sanity/schemas/objects/layout/`) — CMS fields
- **TypeScript interface** (`types/index.ts`) — mirrors schema shape
- **React component** (`components/custom/layouts/`) — renders the block
- **Registry** (`block-renderer.tsx`) — maps `_type` strings to components via `COMPONENT_REGISTRY`

`BlockRenderer` handles: component lookup, error boundaries, scroll-based entrance animations (skipped for hero), and Suspense.

### Form Pipeline
General inquiry, training contact, contact popup, and booking marketing choice flows:
1. Client-side validation (`lib/form-validation.ts`) with shared `ValidationRule` types
2. Server action or booking service re-validates and writes to private DB-backed marketing/contact storage
3. Emails sent non-blocking via `Promise.allSettled` through Resend (`lib/email.ts`) after private DB persistence
4. Field-level errors returned to client via `FormActionResult`

### Sanity

**Private PII Guardrail:** Do not store new checkout transaction history, customer PII, form/contact submissions, marketing contacts, consent events, checkout tokens, Helcim invoice identifiers, Helcim transaction identifiers, payment reconciliation records, or encrypted Helcim secret tokens in public Sanity datasets or expose them through Studio. Use the private PostgreSQL database for sensitive private records.

**Clients** (three, for separation of concerns):
- `sanity/lib/client.ts` — read-only, CDN-enabled
- `sanity/lib/write-client.ts` — server-only, token-authenticated, for mutations
- `sanity/lib/form-client.ts` — server-only, legacy/conditional Sanity submission writes only if explicitly retained

**Schemas:**
- `schemas/documents/` — document types (pages, global settings, legacy/backfill submission types)
- `schemas/objects/layout/` — block types that compose pages
- `schemas/objects/shared/` — reusable field objects (link, feature, hours, contact, menu items)

### Image Remotes (`next.config.ts`)
- Sanity CDN (`cdn.sanity.io`) — primary
- Strapi (`strapiapp.com`) — legacy
- Vercel Blob

### Path Alias
`@/*` → `src/*`

## Environment Variables

- `NEXT_PUBLIC_SANITY_PROJECT_ID`, `NEXT_PUBLIC_SANITY_DATASET` — Sanity connection
- `SANITY_WRITE_TOKEN` — server-side mutations
- `DATABASE_URL` — server-only private PostgreSQL connection
- `RESEND_API_KEY`, `FROM_EMAIL`, `ADMIN_EMAIL` — email delivery
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob (image migration scripts)

## Testing

Playwright E2E in `/tests`. Tests auto-start dev server. Uses semantic selectors (`getByRole`, `getByLabel`). Helpers in `tests/utils/test-helpers.ts`. Runs against Chromium, Firefox, WebKit.
