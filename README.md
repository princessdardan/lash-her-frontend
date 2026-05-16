# Lash Her by Nataliea - Operator Runbook

Lash Her is a beauty and lash artistry platform built with Next.js 16 and Sanity CMS. This repository contains the public storefront, an embedded Sanity Studio, and service integrations for booking and commerce.

## Quick Start

1. Install dependencies: `npm install`
2. Configure environment: `cp .env.local.example .env.local`
3. Start development server: `npm run dev`
4. Open [http://localhost:3000](http://localhost:3000)

## Core Commands

- `npm run dev`: Start local development server
- `npm run build`: Build for production
- `npm run lint`: Run ESLint and type checks
- `npm test`: Run Playwright E2E tests
- `npm run db:generate`: Generate database migrations
- `npm run db:migrate`: Apply database migrations
- `node scripts/validate-sanity-env.mjs`: Validate launch environment variables

## Environment Setup

The application requires several service integrations. See `.env.local.example` for the full list of required variables.

### Sanity CMS
- Project ID: `3auncj84`
- Production Dataset: `production`
- Staging Dataset: `staging-2026-05-10`
- API Version: `2026-03-24`

### Booking System
Google Calendar integration requires OAuth credentials and an Upstash KV store for token persistence.
- Visit `/api/booking/oauth/start?secret=<BOOKING_ADMIN_SETUP_SECRET>` to connect the primary calendar.
- Treat the setup URL as sensitive because it contains a secret; do not share it in chat or ticket systems, and rotate `BOOKING_ADMIN_SETUP_SECRET` after setup if it may have been logged.
- Configure the connected calendar ID in the Sanity `bookingSettings` singleton.

### Checkout and Private DB
Checkout uses Helcim for payments and a private Neon/Drizzle database for order records.
- **PII Policy:** Never store transaction history, customer PII, or payment tokens in Sanity.
- Database migrations live in `drizzle/`.

### Email
Transactional emails are sent via Resend. Ensure `RESEND_API_KEY`, `FROM_EMAIL`, and `ADMIN_EMAIL` are configured.

## Sanity Workflow

The Sanity Studio is embedded at `/studio`.

1. **Schema Changes:** Modify code in `src/sanity/schemas/`, then deploy:
   `npx sanity schema deploy`
2. **Content Promotion:** Follow the guidance in `docs/sanity-staging-production-workflow.md`.
3. **Revalidation:** The app uses a webhook at `/api/revalidate` to clear Next.js cache tags.
   - Endpoint: `/api/revalidate`
   - Projection: `{ _type }`
   - Secret: `SANITY_WEBHOOK_SECRET`
   - Behavior: `revalidateTag(tag, { expire: 0 })` for immediate updates.

## Validation and Smoke Testing

Before promoting to production, run the validation suite:

```bash
npm run lint
npm run build
npm test
node scripts/validate-sanity-env.mjs
VERCEL_ENV=preview node scripts/validate-sanity-env.mjs
VERCEL_ENV=production node scripts/validate-sanity-env.mjs
```

The application also validates `VERCEL_ENV` to ensure environment parity.
Use `VERCEL_ENV=preview` for staging checks, which requires `NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10`.
Use `VERCEL_ENV=production` for production checks, which requires `NEXT_PUBLIC_SANITY_DATASET=production`.

### Launch Smoke Matrix
Verify these document types in the target environment:
- `homePage` -> `/`
- `contactPage` -> `/contact`
- `galleryPage` -> `/gallery`
- `globalSettings` -> All pages (header/footer)
- `mainMenu` -> All pages (navigation)
- `trainingPage` -> `/training`
- `trainingProgramsPage` -> `/training-programs`
- `trainingProgram` -> `/training-programs/[slug]`
- `sellableProduct` -> `/products/[slug]`
- `bookingSettings` -> `/booking`

See `docs/launch-readiness-checklist.md` for full smoke evidence requirements.

## Launch Stop Conditions

Do not promote to production if:
1. Production dataset or project ID cannot be verified.
2. A production publish does not appear on the public page after signed webhook delivery.
3. Webhook targets the wrong dataset or cache tag.
4. Environment validation fails for any production-critical secret.
5. Stale content from a previous dataset refresh is present in the production target.
