# CLAUDE.md

## Project Overview

Lash Her by Nataliea — a beauty/lash artistry business site. Monorepo with a Next.js frontend (primary) and a legacy Strapi backend (`/backend`, rarely touched).

## Commands

All frontend commands run from `/frontend`:

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
- **Sanity v3** — primary CMS for all content and forms
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
Two forms (General Inquiry, Training Contact):
1. Client-side validation (`lib/form-validation.ts`) with shared `ValidationRule` types
2. Server action (`app/actions/form.ts`) re-validates, writes to Sanity via `writeClient`
3. Emails sent non-blocking via `Promise.allSettled` through Resend (`lib/email.ts`)
4. Field-level errors returned to client via `FormActionResult`

### Sanity

**Clients** (three, for separation of concerns):
- `sanity/lib/client.ts` — read-only, CDN-enabled
- `sanity/lib/write-client.ts` — server-only, token-authenticated, for mutations
- `sanity/lib/form-client.ts` — server-only, for form submission writes

**Schemas:**
- `schemas/documents/` — document types (pages, global settings, form submissions)
- `schemas/objects/layout/` — block types that compose pages
- `schemas/objects/shared/` — reusable field objects (link, feature, hours, contact, menu items)

### Image Remotes (`next.config.ts`)
- Sanity CDN (`cdn.sanity.io`) — primary
- Strapi (`strapiapp.com`) — legacy
- Vercel Blob

### Path Alias
`@/*` → `frontend/src/*`

## Environment Variables

- `NEXT_PUBLIC_SANITY_PROJECT_ID`, `NEXT_PUBLIC_SANITY_DATASET` — Sanity connection
- `SANITY_WRITE_TOKEN` — server-side mutations
- `RESEND_API_KEY`, `FROM_EMAIL`, `ADMIN_EMAIL` — email delivery
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob (image migration scripts)

## Testing

Playwright E2E in `/frontend/tests/`. Tests auto-start dev server. Uses semantic selectors (`getByRole`, `getByLabel`). Helpers in `tests/utils/test-helpers.ts`. Runs against Chromium, Firefox, WebKit.
