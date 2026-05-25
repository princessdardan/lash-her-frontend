# Lash Her by Nataliea

Lash Her is a production Next.js app for a beauty and lash artistry business. It combines the public marketing site, product and training checkout, paid service booking, webhook handling, a private operational database, and an embedded Sanity Studio in one repository.

The important architectural split is deliberate:

- **Sanity stores public/editorial content**: pages, navigation, products, services, booking settings, training program content, and reusable content blocks.
- **PostgreSQL stores private operational data**: orders, service holds, payment events, training enrollments, marketing contacts, contact submissions, consent events, and anything containing customer PII or payment history.

This README explains what the codebase does, where the major pieces live, how to run and change it, and why the boundaries exist.

## Table of contents

- [What this codebase contains](#what-this-codebase-contains)
- [How the application works](#how-the-application-works)
- [Where things live](#where-things-live)
- [Local development](#local-development)
- [Environment and services](#environment-and-services)
- [Sanity CMS workflow](#sanity-cms-workflow)
- [Booking, checkout, and private data](#booking-checkout-and-private-data)
- [Testing and verification](#testing-and-verification)
- [Deployment and launch checks](#deployment-and-launch-checks)
- [Operational rules](#operational-rules)
- [Further documentation](#further-documentation)

## What this codebase contains

This repository is the active root package for the Lash Her frontend and server routes. There is no separate nested `frontend/` app.

Main capabilities:

- **Public website**: homepage, contact, gallery, products, services, booking entry points, and training program pages.
- **Embedded Sanity Studio**: available at `/studio` and configured from source in `src/sanity/sanity.config.ts`.
- **Sanity-backed page rendering**: public routes load CMS content through shared loader functions and typed projections.
- **Service booking flow**: availability lookup, hold creation, checkout handoff, payment reconciliation, and Google Calendar finalization.
- **Product checkout**: Helcim-backed checkout for catalog purchases.
- **Training checkout**: Helcim-backed enrollment purchase flow.
- **Private database storage**: Drizzle/PostgreSQL persistence for sensitive and operational records.
- **Webhook handling**: Sanity revalidation, Helcim card transaction handling, and Square service-booking webhook handling.
- **Transactional email**: Resend-backed customer/admin notifications.

## How the application works

At runtime, the app has three main data planes.

### 1. Public content plane

Sanity contains content editors should manage: page content, menus, product/service/training copy, global settings, reusable blocks, and booking configuration.

The public site reads Sanity through `src/data/loaders.ts`. Those loaders centralize GROQ queries, projections, and Next cache tags so routes do not create ad hoc CMS clients or divergent query behavior.

### 2. Private operational plane

Customer submissions, checkout records, payment events, consent events, enrollments, and booking holds are written to PostgreSQL through `src/lib/private-db` and domain modules under `src/lib`. This keeps sensitive data out of the CMS and gives operational flows transactional storage.

### 3. External service plane

The app integrates with:

- **Sanity** for content and Studio.
- **Helcim** for product and training checkout.
- **Square** for paid service booking when `SERVICE_BOOKING_SQUARE_ENABLED=true`.
- **Google Calendar** for final appointment creation after booking payment reconciliation.
- **Upstash Redis/KV** for booking OAuth token persistence.
- **Resend** for transactional email.
- **Vercel** for hosting, analytics, speed insights, and environment-scoped deployments.

## Where things live

| Area | Path | Why it exists |
| --- | --- | --- |
| Public routes | `src/app/(site)` | Next App Router pages for the public website. |
| API routes | `src/app/api` | Server endpoints for booking, checkout, promotion codes, revalidation, and webhooks. |
| Global app shell | `src/app/layout.tsx`, `src/app/(site)/layout.tsx`, `src/app/globals.css` | Metadata, root layout, site shell, Tailwind v4 theme tokens, and global styling. |
| Sanity Studio route | `src/app/studio` | Mounts the embedded Studio at `/studio`. |
| Sanity config and schemas | `src/sanity` | Studio config, schema source, structure builder, and Sanity clients. |
| Sanity loaders | `src/data/loaders.ts` | Centralized CMS reads, GROQ projections, and cache tagging. |
| Shared content types | `src/types/index.ts` | TypeScript shapes for CMS-backed rendering and block unions. |
| Components | `src/components` | Booking, commerce, custom CMS block rendering, and shared UI components. |
| Booking domain logic | `src/lib/booking` | Availability, holds, payment-provider logic, and calendar integration helpers. |
| Commerce domain logic | `src/lib/commerce` | Checkout/payment behavior for product and related commerce flows. |
| Private database | `src/lib/private-db`, `drizzle/` | Drizzle schema/client plus generated migrations. |
| Email | `src/lib/email.ts` | Transactional email integration. |
| Environment helpers | `src/lib/env`, `src/sanity/env.ts` | Runtime configuration parsing and Sanity environment constants. |
| Tests | `src/**/*.test.ts`, `tests/` | Node unit/route tests near source and Playwright E2E tests. |
| Operational docs | `docs/` | Detailed runbooks, architecture notes, flowcharts, and launch checklists. |
| Scripts | `scripts/` | Environment validation, migrations, and git remote guardrails. |

## Local development

### Requirements

- Node.js compatible with Next.js 16.
- npm.
- Access to the required service credentials for the flows you need to test.
- PostgreSQL connection string for private checkout/booking storage.

### Quick start

```bash
npm install
cp .env.local.example .env.local
npm run dev
```

Then open:

- Public site: [http://localhost:3000](http://localhost:3000)
- Sanity Studio: [http://localhost:3000/studio](http://localhost:3000/studio)

### Core commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the Next.js development server. |
| `npm run build` | Runs `prebuild` Sanity env validation, then creates a production build. |
| `npm run start` | Starts the production Next server after a build. |
| `npm run lint` | Runs ESLint. |
| `npm test` | Runs Playwright E2E tests. |
| `npm run test:unit` | Runs `src/**/*.test.ts` through Node's test runner via `tsx`. |
| `npm run test:ui` | Opens the Playwright UI runner. |
| `npm run test:headed` | Runs Playwright headed. |
| `npm run test:debug` | Runs Playwright in debug mode. |
| `npm run test:report` | Opens the last Playwright HTML report. |
| `npm run db:generate` | Generates Drizzle migrations from schema changes. |
| `npm run db:migrate` | Applies private database migrations using `DATABASE_URL`. |
| `npm run git:verify-remote` | Verifies the `frontend` git remote points at the canonical repository. |
| `npm run git:push-staging` | Verifies the remote, then pushes the `staging` branch to `frontend`. |

## Environment and services

Use `.env.local.example` as the source of truth for local variables.

### Sanity

- Project ID: `3auncj84`
- API version: `2026-03-24`
- Production dataset: `production`
- Staging/preview dataset: `staging-2026-05-10`

Dataset alignment is enforced by `scripts/validate-sanity-env.mjs`:

- `VERCEL_ENV=preview` expects `NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10`.
- `VERCEL_ENV=production` expects `NEXT_PUBLIC_SANITY_DATASET=production`.

`npm run build` runs this validation before `next build`, so a mismatched dataset can fail the build before Next.js starts compiling.

### Email

Transactional email uses Resend. Configure:

- `RESEND_API_KEY`
- `FROM_EMAIL`
- `ADMIN_EMAIL`

### Google Calendar and booking OAuth

Google Calendar integration requires OAuth credentials and Upstash Redis/KV token storage:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `BOOKING_ADMIN_SETUP_SECRET`
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

The booking OAuth setup URL is:

```text
/api/booking/oauth/start?secret=<BOOKING_ADMIN_SETUP_SECRET>
```

Treat that URL as sensitive. Do not paste it in tickets or chat because it contains the setup secret.

### Private database

Set `DATABASE_URL` to the Neon/PostgreSQL database used for private operational records. Migrations live in `drizzle/` and are applied with `npm run db:migrate`.

### Payments

`PAYMENT_GATEWAY_MODE` controls live vs local mock payment behavior.

- Use `PAYMENT_GATEWAY_MODE=live` for real environments.
- Use `PAYMENT_GATEWAY_MODE=mock` only for local/dev payment testing.
- Mock mode is server-only and rejected in production.
- Dev-only mock controls are `x-lash-payment-mock-scenario` and `mockPaymentScenario`.

Product checkout and training checkout use Helcim:

- `HELCIM_GENERAL_API_TOKEN`
- `HELCIM_TRANSACTION_API_TOKEN`
- `CHECKOUT_SECRET_ENCRYPTION_KEY`
- `HELCIM_WEBHOOK_VERIFIER_TOKEN`

Paid service bookings use Square only when enabled:

- `SERVICE_BOOKING_SQUARE_ENABLED=true`
- `SQUARE_ENVIRONMENT=sandbox` or `production`
- `SQUARE_ACCESS_TOKEN`
- `SQUARE_LOCATION_ID`
- `SQUARE_WEBHOOK_SIGNATURE_KEY`
- `SQUARE_SERVICE_BOOKING_RETURN_URL`
- `SQUARE_SERVICE_BOOKING_WEBHOOK_URL`

Helcim webhook delivery must target `/api/webhooks/card-transactions` and must not contain `helcim` in the URL.

## Sanity CMS workflow

The Studio is embedded at `/studio`, but schemas are source-driven from this repository.

### Changing schemas

1. Edit schema files in `src/sanity/schemas/**`.
2. Update related TypeScript content shapes in `src/types/index.ts` when the public app consumes the fields.
3. Update GROQ projections in `src/data/loaders.ts`.
4. Update rendering components under `src/components/**` when the content appears on the site.
5. For new CMS blocks, wire the block into `COMPONENT_REGISTRY` in `src/components/custom/layouts/block-renderer.tsx`.
6. Deploy the schema with:

```bash
npx sanity schema deploy
```

`sanity.cli.ts` targets the `production` dataset by default, so be explicit before schema or dataset operations if you are working against staging.

### Content promotion

Use `docs/sanity-staging-production-workflow.md` for staging-to-production content workflow details.

### Revalidation

Sanity publishes should hit `/api/revalidate` with `SANITY_WEBHOOK_SECRET`.

The route maps changed document types to cache tags and uses `revalidateTag(tag, { expire: 0 })` for immediate Next.js 16 cache expiry. Keep cache tags in `src/data/loaders.ts` aligned with `TYPE_TAG_MAP` in `src/app/api/revalidate/route.ts`.

## Booking, checkout, and private data

### Service booking

Service booking is intentionally payment-reconciled. Direct booking creation is disabled; confirmed appointments are created only after secure server-side payment reconciliation.

Important areas:

- Public booking UI: `src/app/(site)/booking`, `src/components/booking`
- Booking API routes: `src/app/api/booking`
- Booking domain logic: `src/lib/booking`
- Google OAuth: `src/app/api/booking/oauth`
- Square service booking flow: `src/app/api/booking/square`, `src/app/api/webhooks/square`
- Booking settings content: Sanity `bookingSettings`

### Product checkout

Product checkout is Helcim-backed and exposed through `src/app/api/checkout`. Product content comes from Sanity, while order/payment state is private database data.

### Training checkout

Training program pages live under `/training-programs`; `/training` redirects there. Training checkout is Helcim-backed through `src/app/api/training-checkout`, with enrollment/payment records stored privately.

### Privacy boundary

Never store these in Sanity:

- Customer PII from live submissions.
- Transaction history.
- Payment tokens or secrets.
- Marketing contacts.
- Contact submissions.
- Consent events.
- Training enrollment records.
- Booking holds or payment events.

Write private records first, then send email as a non-blocking side effect where applicable.

## Testing and verification

### Routine checks

```bash
npm run lint
npm run test:unit
npm test
npm run build
```

Use focused commands while developing:

```bash
npx tsx --test src/path/to/file.test.ts
npx playwright test tests/<file>.spec.ts --project=chromium
```

### Environment checks

```bash
node scripts/validate-sanity-env.mjs
VERCEL_ENV=preview node scripts/validate-sanity-env.mjs
VERCEL_ENV=production node scripts/validate-sanity-env.mjs
```

### Smoke matrix

Before promoting content or deploying production-critical changes, verify the target environment renders the Sanity-backed pages and flows that correspond to changed content:

- `homePage` -> `/`
- `contactPage` -> `/contact`
- `galleryPage` -> `/gallery`
- `globalSettings` -> all pages, especially header/footer
- `mainMenu` -> all navigation surfaces
- `trainingProgramsPage` -> `/training-programs`
- `trainingProgram` -> `/training-programs/[slug]`
- `product` -> `/products/[slug]`
- `service` / `bookingOffering` -> `/services`, `/services/[slug]`, `/booking?offering=<slug>`
- `bookingSettings` -> `/booking`

See `docs/launch-readiness-checklist.md` for full smoke evidence requirements.

## Deployment and launch checks

This app is designed for Vercel deployment with environment-scoped variables.

Before production promotion:

1. Confirm the deployment is using Sanity project `3auncj84` and dataset `production`.
2. Run lint, unit tests, relevant Playwright tests, and `npm run build`.
3. Confirm signed Sanity webhook delivery updates the public page after publishing.
4. Confirm webhook cache tags match the changed document types.
5. Confirm production-critical secrets are present in the production environment only.
6. Confirm staging-only payment mocks are not enabled in production.
7. Confirm Square production credentials are scoped only to production when service booking uses Square.

Do not promote if:

- Production dataset or project ID cannot be verified.
- A production publish does not appear on the public page after signed webhook delivery.
- A webhook targets the wrong dataset or cache tag.
- Environment validation fails for a production-critical secret or dataset.
- Stale content from a previous dataset refresh is present in production.

## Operational rules

- Run commands from the repository root.
- Add Sanity reads through `src/data/loaders.ts`; do not create a parallel public CMS data layer.
- Keep Sanity client purposes separate: read client, write client, and legacy/editor form client live under `src/sanity/lib`.
- Keep private form, booking, consent, checkout, payment, marketing, and training enrollment data in PostgreSQL, not Sanity.
- Keep `src/data/loaders.ts` cache tags aligned with `src/app/api/revalidate/route.ts`.
- Use `parseBody()` from `next-sanity/webhook` before consuming the revalidation request body.
- For CMS block additions, update schema, types, GROQ projection, React renderer, and `COMPONENT_REGISTRY` together.
- Tailwind v4 is CSS-first in `src/app/globals.css`; there is no `tailwind.config.*`.
- React Compiler is enabled in `next.config.ts`; avoid render-time mutation patterns.
- Brand direction is quiet luxury/editorial restraint. Treat `docs/lash-her-brand-kit.html` and `src/app/globals.css` as visual sources of truth.
- Redirects in `next.config.ts` include `/homepage` -> `/` and `/training` -> `/training-programs`.
- Before branch push or PR work, verify the canonical remote is `https://github.com/princessdardan/lash-her-frontend.git`.

## Further documentation

- `docs/booking-system-architecture-reference.md` - current booking architecture and provider boundaries.
- `docs/booking-system-runbook.md` - booking operations runbook.
- `docs/booking-system-setup-guide.md` - environment setup for booking, payment, calendar, and email services.
- `docs/square-service-booking-setup.md` - Square service-booking environment variables and webhook setup for local, staging, and production.
- `docs/booking-payment-provider-split.md` - Helcim/Square provider split.
- `docs/google-calendar-oauth-env-setup.md` - Google Calendar OAuth setup.
- `docs/private-database-migration-runbook.md` - private DB migration process.
- `docs/marketing-contact-privacy-compliance-follow-up.md` - privacy/compliance operating guidance for marketing and contact data.
- `docs/sanity-staging-production-workflow.md` - Sanity dataset/content promotion workflow.
- `docs/launch-readiness-checklist.md` - launch smoke and readiness checklist.
- `docs/lash-her-brand-kit.html` - visual and brand reference.
