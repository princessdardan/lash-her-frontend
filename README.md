# Lash Her by Nataliea

Lash Her is a production Next.js app for a beauty and lash artistry business. It combines the public marketing site, product and training checkout, paid service booking, webhook handling, an operational PostgreSQL database, and an embedded Sanity Studio in one repository.

The important architectural split is deliberate:

- **Sanity stores public/editorial content**: pages, navigation, products, training program content, reusable content blocks, and service-detail copy, media, and SEO. The active Studio does not register the legacy `bookingSettings` schema.
- **PostgreSQL stores operational and private data**: the public service-booking catalog and configuration, orders, service holds, payment events, appointments, training enrollments, marketing contacts, contact submissions, consent events, and anything containing customer PII or payment history.

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
- **Service booking flow**: PostgreSQL-backed availability and holds, direct Square charge-and-store confirmation, payment reconciliation, and Google Calendar finalization.
- **Product checkout**: Square-backed checkout for catalog purchases.
- **Training checkout**: Square-backed enrollment purchase flow.
- **Operational database storage**: Drizzle/PostgreSQL persistence for the public booking control plane and sensitive records.
- **Webhook handling**: Sanity revalidation and Square webhook handling for product checkout, training checkout, and service booking.
- **Transactional email**: Resend-backed customer, provider, and admin notifications.

## How the application works

At runtime, the app has three main data planes.

### 1. Public content plane

Sanity contains content editors should manage: page content, menus, product and training copy, global settings, reusable blocks, and service-detail editorial copy, media, and SEO. Operational service titles, summaries, intake content, prices, schedules, and booking settings live in PostgreSQL. The legacy Sanity `bookingSettings` document remains runtime-readable for V1 compatibility and recovery, as well as one-time imports, but is excluded from the active Studio schema and structure.

The public site reads Sanity through `src/data/loaders.ts`. Those loaders centralize GROQ queries, projections, and Next cache tags so routes do not create ad hoc CMS clients or divergent query behavior.

### 2. Operational database plane

Operational public booking configuration and catalog data, customer submissions, checkout records, payment events, consent events, enrollments, appointments, and booking holds are written to PostgreSQL through `src/lib/private-db` and domain modules under `src/lib`. This keeps booking authority and sensitive data out of the CMS and gives operational flows transactional storage.

### 3. External service plane

The app integrates with:

- **Sanity** for content and Studio.
- **Square** for product and training checkout (Web Payments SDK) when `SQUARE_COMMERCE_ENABLED=true`, and for paid service booking when `SERVICE_BOOKING_SQUARE_ENABLED=true`.
- **Google Calendar** for final appointment creation after booking payment reconciliation.
- **Upstash Redis/KV** for short-lived booking OAuth state and locks, plus legacy global-calendar token compatibility.
- **Resend** for transactional email.
- **Vercel** for hosting, analytics, speed insights, and environment-scoped deployments.

## Where things live

| Area                      | Path                                                                     | Why it exists                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Public routes             | `src/app/(site)`                                                         | Next App Router pages for the public website.                                                                             |
| API routes                | `src/app/api`                                                            | Server endpoints for booking, checkout, training checkout, admin, cron jobs, promotion codes, revalidation, and webhooks. |
| Global app shell          | `src/app/layout.tsx`, `src/app/(site)/layout.tsx`, `src/app/globals.css` | Metadata, root layout, site shell, Tailwind v4 theme tokens, and global styling.                                          |
| Sanity Studio route       | `src/app/studio`                                                         | Mounts the embedded Studio at `/studio`.                                                                                  |
| Sanity config and schemas | `src/sanity`                                                             | Studio config, schema source, structure builder, and Sanity clients.                                                      |
| Sanity loaders            | `src/data/loaders.ts`                                                    | Centralized CMS reads, GROQ projections, and cache tagging.                                                               |
| Admin dashboard           | `src/app/admin`, `src/lib/admin`                                         | Authenticated operational configuration, booking, commerce, marketing, and audit surfaces.                                |
| Shared content types      | `src/types/index.ts`                                                     | TypeScript shapes for CMS-backed rendering and block unions.                                                              |
| Components                | `src/components`                                                         | Booking, commerce, custom CMS block rendering, and shared UI components.                                                  |
| Booking domain logic      | `src/lib/booking`                                                        | Availability, holds, payment-provider logic, and calendar integration helpers.                                            |
| Commerce domain logic     | `src/lib/commerce`                                                       | Checkout/payment behavior for product and related commerce flows.                                                         |
| Operational database      | `src/lib/private-db`, `drizzle/`                                         | Drizzle schema/client plus generated migrations.                                                                          |
| Email                     | `src/lib/email.ts`                                                       | Transactional email integration.                                                                                          |
| Environment helpers       | `src/lib/env`, `src/sanity/env.ts`                                       | Runtime configuration parsing and Sanity environment constants.                                                           |
| Tests                     | `src/**/*.test.ts`, `tests/`                                             | Node unit/route tests near source and Playwright E2E tests.                                                               |
| Operational docs          | `docs/`                                                                  | Current setup guides, operational runbooks, and launch/cutover checklists.                                                |
| Scripts                   | `scripts/`                                                               | Environment validation, migrations, and git remote guardrails.                                                            |

## Local development

### Requirements

- Node.js 24 LTS (run `nvm use` to select the repository version).
- npm.
- Access to the required service credentials for the flows you need to test.
- PostgreSQL connection string for operational booking and private customer/payment storage.

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

| Command                     | What it does                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `npm run dev`               | Starts the Next.js development server.                                              |
| `npm run build`             | Runs `prebuild` Sanity env validation, then creates a production build.             |
| `npm run start`             | Starts the production Next server after a build.                                    |
| `npm run lint`              | Runs ESLint.                                                                        |
| `npm test`                  | Runs Playwright E2E tests.                                                          |
| `npm run test:unit`         | Runs every DB-disabled source test plus script tests.                               |
| `npm run test:unit:db`      | Runs every registered DB-backed source test serially; requires `TEST_DATABASE_URL`. |
| `npm run test:unit:all`     | Runs the DB-disabled, script, and registered DB-backed suites.                      |
| `npm run test:ui`           | Opens the Playwright UI runner.                                                     |
| `npm run test:headed`       | Runs Playwright headed.                                                             |
| `npm run test:debug`        | Runs Playwright in debug mode.                                                      |
| `npm run test:report`       | Opens the last Playwright HTML report.                                              |
| `npm run db:generate`       | Generates Drizzle migrations from schema changes.                                   |
| `npm run db:check`          | Performs a read-only migration lineage, hash, sequence, and pending-state check.    |
| `npm run db:migrate`        | Applies migrations with explicit target and exact-host guards.                      |
| `npm run git:verify-remote` | Verifies the `origin` git remote points at the canonical repository.                |
| `npm run git:push-staging`  | Verifies the remote, then pushes the `staging` branch to `origin`.                  |

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

Draft preview and the Studio Presentation tool require `SANITY_API_READ_TOKEN` so `/api/draft-mode/enable` can validate preview URLs and read draft documents. `/api/draft-mode/disable` exits preview mode.

### Email

Transactional email uses Resend. Configure:

- `RESEND_API_KEY`
- `RESEND_WEBHOOK_SECRET`
- `RESEND_SEGMENT_MARKETING_ID`
- `FROM_EMAIL`
- `ADMIN_EMAIL`
- `RESEND_MARKETING_SYNC_CRON_SECRET` to enable the marketing-contact sync endpoint

Optional `RESEND_TEMPLATE_*_ID`, `RESEND_SEGMENT_*_ID`, and `RESEND_TOPIC_*_ID` variables connect website email and consent flows to Resend Dashboard templates, contact segments, topic preferences, automations, and broadcasts. See `docs/resend-transactional-email-setup.md` for the full mapping and webhook setup, and `docs/scheduled-jobs-runbook.md` for scheduled endpoint authentication and ownership.

### Google Calendar and booking OAuth

Google Calendar integration requires OAuth credentials and a separate encryption key:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY`
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

Owners and administrators connect business calendars at `/admin/calendar-connections`; employees manage their assigned connection at `/admin/my-calendar`. These operational credentials are encrypted with `BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY` and stored in PostgreSQL. Redis stores short-lived OAuth state and coordination locks.

`BOOKING_ADMIN_SETUP_SECRET` and the Redis-backed global refresh token remain only for the legacy compatibility flow. Do not share that setup URL or include it in documentation, tickets, or chat. Legacy refresh tokens are namespaced by `VERCEL_TARGET_ENV` (falling back to `VERCEL_ENV`), so preview/staging setup cannot replace the production token when environments share one Redis instance.

### Operational PostgreSQL database

Set `DATABASE_URL` to the Neon/PostgreSQL database used for operational booking configuration and private records. Migrations live in `drizzle/`. Run `npm run db:check` before and after applying them. `npm run db:migrate` fails closed unless `PRIVATE_DB_MIGRATION_TARGET` and an exact `PRIVATE_DB_MIGRATION_HOST` match the intended target; production also requires `PRIVATE_DB_MIGRATION_CONFIRM=production`.

### Scheduled jobs, backups, and telemetry

Vercel scheduled endpoints use `CRON_SECRET`. Payment reconciliation and marketing sync also require their route-enabling `PAYMENT_RECONCILIATION_CRON_SECRET` and `RESEND_MARKETING_SYNC_CRON_SECRET`; only after the relevant secret exists will that route accept the shared bearer. The shipping routes additionally accept `CHITCHATS_WORKER_CRON_SECRET`. See `docs/scheduled-jobs-runbook.md` for the endpoint inventory, cadence ownership, and failure behavior.

`BACKUP_VALIDATION_ENABLED` plus the `BACKUP_GCS_BUCKET_URI`, `BACKUP_RESTORE_DATABASE_URL`, and `BACKUP_RESTORE_EXPECTED_DB_NAME` settings enable only a fail-closed configuration check. The current endpoint does not restore or validate a backup and reports that an external restore runner is required. Do not treat a successful scaffold response as restore evidence.

Node telemetry is optional and remains disabled unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. `OTEL_SERVICE_NAME` defaults to `lash-her-frontend` when omitted.

### Payments

`PAYMENT_GATEWAY_MODE` controls live vs local mock payment behavior.

- Use `PAYMENT_GATEWAY_MODE=live` for real environments.
- Use `PAYMENT_GATEWAY_MODE=mock` only for local/dev payment testing.
- Mock mode is server-only and rejected in production.
- Dev-only mock controls are `x-lash-payment-mock-scenario` and `mockPaymentScenario`.

Product checkout and training checkout use Square (Web Payments SDK), enabled with `SQUARE_COMMERCE_ENABLED=true`:

- `SQUARE_ENVIRONMENT` (`sandbox` or `production`)
- `SQUARE_ACCESS_TOKEN`
- `SQUARE_LOCATION_ID`
- `SQUARE_APPLICATION_ID`
- `SQUARE_WEBHOOK_SIGNATURE_KEY`
- `CHECKOUT_SECRET_ENCRYPTION_KEY`

`SQUARE_APPLICATION_ID` and `SQUARE_LOCATION_ID` are served to the browser through `/api/checkout/square/config` so the Web Payments SDK can tokenize the card in Square's own iframe; the card PAN never reaches the server. The server uses `SQUARE_ACCESS_TOKEN` for the authorize/capture and refund calls, recomputing the charged amount from trusted order state. Product checkout, training checkout, the optional training Afterpay invoice, and service booking all share the single Square webhook endpoint (`/api/webhooks/square`), verified with `SQUARE_WEBHOOK_SIGNATURE_KEY`.

Paid service bookings use Square only when enabled:

- `SERVICE_BOOKING_SQUARE_ENABLED=true`
- `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true`
- `SQUARE_ENVIRONMENT=sandbox` or `production`
- `SQUARE_ACCESS_TOKEN`
- `SQUARE_LOCATION_ID`
- `SQUARE_APPLICATION_ID`
- `SQUARE_WEBHOOK_SIGNATURE_KEY`
- `SQUARE_SERVICE_BOOKING_RETURN_URL`
- `SQUARE_SERVICE_BOOKING_WEBHOOK_URL`

The active public service flow captures the required deposit, full amount, or configured custom partial amount and stores a reusable Square card reference through the `CHARGE_AND_STORE` confirmation flow. The public payment config and form are unavailable when direct charge-and-store is disabled or incomplete; the UI does not fall back to a hosted Payment Link. The return route and webhook retain reconciliation support for historical hosted service-payment sessions. All Square events (product, training, and service booking) are delivered to the single webhook endpoint `/api/webhooks/square`.

Historical Helcim records remain readable through the retained `helcim` provider enum value and generic provider fields. The provider-specific `helcim_*` columns have been dropped, and no active flow creates new Helcim payments.

### Product shipping

Chit Chats provides live insured tracked product-shipping rates, staff label purchase, tracking polling, and delivery notifications. Configure:

- `CHITCHATS_SHIPPING_ENABLED`
- `CHITCHATS_CHECKOUT_ENABLED`
- `FLAT_RATE_SHIPPING_ENABLED` when the flat-rate estimator and weekly cache refresh are intentionally enabled
- `CHITCHATS_US_SHIPPING_ENABLED`
- `CHITCHATS_ENVIRONMENT=staging` or `production`
- `CHITCHATS_CLIENT_ID`
- `CHITCHATS_REGION=british_columbia|alberta_saskatchewan|ontario_manitoba|quebec|atlantic`
- `CHITCHATS_ACCESS_TOKEN`
- `CHITCHATS_QUOTE_SIGNING_SECRET`
- `CHITCHATS_WORKER_CRON_SECRET`
- `CHECKOUT_PII_ENCRYPTION_KEY` (base64-encoded 32-byte key)
- `SHIPPING_DECISION_TOKEN_SECRET` (at least 32 bytes)
- `ADDRESS_CHANGE_TOKEN_SECRET` (at least 32 bytes)
- `BACKUP_RETENTION_DAYS` (30 or less)
- Optional `CHITCHATS_TRACKED_POSTAGE_TYPES`

`CHITCHATS_REGION` identifies the region selected in the matching Chit Chats account; it is not a provider branch ID and is not added to API shipment requests. The configured environment, client ID, and region must match exactly. Shipping readiness is source-controlled in `src/lib/shipping/product-shipping-config.ts` and `src/lib/commerce/product-tax-policy.ts`; there is no runtime owner-attestation record or `CHITCHATS_BRANCH_ID` gate.

`CHITCHATS_CHECKOUT_ENABLED` must remain false until `npm run db:migrate` has applied every entry in `drizzle/meta/_journal.json` (not only the original `0032`/`0033` shipping migrations), quarantined upgrade conflicts have been reconciled, package profiles are reviewed, each purchasable Sanity product/variant has complete shipping metadata, and the source-controlled shipping/tax config (`src/lib/shipping/product-shipping-config.ts`, `src/lib/commerce/product-tax-policy.ts`) is populated and business-confirmed. `CHITCHATS_SHIPPING_ENABLED` keeps worker/admin processing active for existing shipments. U.S. shipping and manual product checkout have independent fail-closed flags; disabling one must not be treated as permission to disable processing for already-paid orders.

## Sanity CMS workflow

The Studio is embedded at `/studio`, but schemas are source-driven from this repository.

The active schema intentionally excludes the legacy `bookingSettings` document. Do not recreate or edit it as current runtime configuration; operational booking settings, offerings, schedules, and intake content are managed in PostgreSQL through `/admin`.

### Changing schemas

1. Edit schema files in `src/sanity/schemas/**`.
2. Update related TypeScript content shapes in `src/types/index.ts` when the public app consumes the fields.
3. Update GROQ projections in `src/data/loaders.ts`.
4. Update rendering components under `src/components/**` when the content appears on the site.
5. For new CMS blocks, wire the block into `COMPONENT_REGISTRY` in `src/components/custom/layouts/block-renderer.tsx`.
6. Deploy the schema against staging explicitly while iterating:

```bash
NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10 npx sanity schema deploy
```

For production schema deploys, confirm intent explicitly after review and approval:

```bash
SANITY_SCHEMA_DEPLOY_TARGET=production NEXT_PUBLIC_SANITY_DATASET=production npx sanity schema deploy
```

`sanity.cli.ts` refuses to target the production dataset without `SANITY_SCHEMA_DEPLOY_TARGET=production`, so be explicit before schema or dataset operations.

### Content promotion

Use `docs/sanity-staging-production-workflow.md` for staging-to-production content workflow details.

### Revalidation

Sanity publishes should hit `/api/revalidate` with `SANITY_WEBHOOK_SECRET`.

The route maps changed document types to cache tags and uses `revalidateTag(tag, { expire: 0 })` for immediate Next.js 16 cache expiry. Keep cache tags in `src/data/loaders.ts` aligned with `TYPE_TAG_MAP` in `src/app/api/revalidate/handler.ts`.

## Booking, checkout, and private data

### Service booking

Service booking is intentionally payment-reconciled. Direct booking creation is disabled; confirmed appointments are created only after the direct Square `CHARGE_AND_STORE` operation is securely reconciled. If direct-payment configuration is unavailable, the public payment form fails closed and does not offer hosted checkout.

Important areas:

- Public service catalog and booking UI: `src/app/(site)/services`, `src/components/booking`
- Legacy entry shim: `/booking` permanently redirects valid legacy links to `/services/[slug]/booking`; bare `/booking` redirects to `/services`
- Booking API routes: `src/app/api/booking`
- Booking domain logic: `src/lib/booking`
- Google OAuth: `src/app/api/booking/oauth`, with operational credentials encrypted in PostgreSQL
- Direct Square confirmation: `src/app/api/booking/payment/confirm`; historical return reconciliation: `src/app/api/booking/square`
- Square webhook reconciliation: `src/app/api/webhooks/square`
- Operational booking configuration: PostgreSQL tables managed through `/admin/booking-settings`, `/admin/offerings`, `/admin/schedules`, and `/admin/calendar-connections`

### Product checkout

Product checkout is Square-backed and exposed through `src/app/api/checkout`. Product content and shipping/customs metadata come from Sanity. Orders, quotes, package profiles, labels, and tracking state are private PostgreSQL data. Chit Chats quote creation is exposed through `src/app/api/shipping/quotes` when enabled.

### Training checkout

Training program pages live under `/training-programs`; `/training` redirects there. Training checkout is Square-backed through `src/app/api/training-checkout`, with enrollment/payment records stored privately.

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

`npm run test:unit` intentionally excludes DB-backed source tests. Use an isolated `TEST_DATABASE_URL` with `npm run test:unit:db`, or `npm run test:unit:all` for both source scopes plus script tests.

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

Before promoting content or deploying production-critical changes, verify the target environment renders the surfaces owned by each data plane.

Sanity-backed editorial content:

- `homePage` -> `/`
- `contactPage` -> `/contact`
- `galleryPage` -> `/gallery`
- `globalSettings` -> all pages, especially header/footer
- `mainMenu` -> all navigation surfaces
- `trainingProgramsPage` -> `/training-programs`
- `trainingProgram` -> `/training-programs/[slug]`
- `product` -> `/products/[slug]`
- `service` -> `/services/[slug]` for linked editorial copy, media, and SEO

PostgreSQL-backed operational booking:

- active public offerings -> `/services`
- offering catalog/intake/settings/schedule -> `/services/[slug]/booking`
- legacy entry compatibility -> `/booking` redirects to `/services`, and valid legacy offering links redirect to the canonical service booking route
- admin configuration -> `/admin/booking-settings`, `/admin/offerings`, `/admin/schedules`, and `/admin/calendar-connections`

See `docs/launch-readiness-checklist.md` for full smoke evidence requirements.

## Deployment and launch checks

This app is designed for Vercel deployment with environment-scoped variables.

Before production promotion:

1. Confirm the deployment is using Sanity project `3auncj84` and dataset `production`.
2. Run `npm run db:check`; apply reviewed pending migrations with the required exact-host and production-confirmation guards before deploying code that depends on them.
3. Run lint, unit tests, relevant Playwright tests, and `npm run build`.
4. Confirm signed Sanity webhook delivery updates the public page after publishing.
5. Confirm webhook cache tags match the changed document types.
6. Confirm production-critical secrets are present in the production environment only.
7. Confirm staging-only payment mocks are not enabled in production.
8. Confirm Square production credentials are scoped only to production when service booking uses Square.

Do not promote if:

- Production dataset or project ID cannot be verified.
- A production publish does not appear on the public page after signed webhook delivery.
- A webhook targets the wrong dataset or cache tag.
- Environment validation fails for a production-critical secret or dataset.
- Stale content from a previous dataset refresh is present in production.

## Operational rules

- Run commands from the repository root.
- Add Sanity reads through `src/data/loaders.ts`; do not create a parallel public CMS data layer.
- Keep Sanity client purposes separate: read client and write client live under `src/sanity/lib`; private form/contact writes belong in PostgreSQL, not Sanity.
- Keep private form, booking, consent, checkout, payment, marketing, and training enrollment data in PostgreSQL, not Sanity.
- Keep `src/data/loaders.ts` cache tags aligned with `TYPE_TAG_MAP` in `src/app/api/revalidate/handler.ts`.
- Use `parseBody()` from `next-sanity/webhook` before consuming the revalidation request body.
- For CMS block additions, update schema, types, GROQ projection, React renderer, and `COMPONENT_REGISTRY` together.
- Tailwind v4 is CSS-first in `src/app/globals.css`; there is no `tailwind.config.*`.
- React Compiler is enabled in `next.config.ts`; avoid render-time mutation patterns.
- Brand direction is quiet luxury/editorial restraint. Treat `docs/lash-her-brand-kit.html` and `src/app/globals.css` as visual sources of truth.
- Redirects in `next.config.ts` include `/homepage` -> `/` and `/training` -> `/training-programs`.
- Before branch push or PR work, verify the canonical remote is `https://github.com/princessdardan/lash-her-frontend.git`.

## Further documentation

- `docs/booking-system-setup-guide.md` - current booking, database, authentication, Calendar, Square, email, and rollout setup.
- `docs/booking-operations-dashboard.md` - canonical operational ownership, dashboard, migration, and cutover guide.
- `docs/booking-system-runbook.md` - live booking operations and recovery runbook.
- `docs/square-service-booking-setup.md` - Square direct charge-and-store and historical reconciliation setup.
- `docs/google-calendar-oauth-env-setup.md` - operational and legacy-compatible Google Calendar OAuth setup.
- `docs/scheduled-jobs-runbook.md` - scheduled endpoint inventory, authentication, ownership, and failure behavior.
- `docs/private-database-migration-runbook.md` - guarded private database migration process.
- `docs/resend-transactional-email-setup.md` - Resend domain, environment, template, webhook, and delivery recovery setup.
- `docs/sanity-staging-production-workflow.md` - Sanity dataset and editorial-content promotion workflow.
- `docs/launch-readiness-checklist.md` - launch smoke and readiness checklist.
- `docs/production-cutover-checklist.md` - reviewed staging-to-production cutover procedure.
- `docs/checkout-flowcharts.html` - current product, training, and operational service-booking flow diagrams.
- `docs/training-afterpay-square-invoice.md` - optional training Afterpay invoice flow.
- `docs/vulnerability-remediation-plan.md` - dependency audit and remediation policy.
- `docs/lash-her-brand-kit.html` - visual and brand reference.
