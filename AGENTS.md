# AGENTS.md

## What this repo is

- Root package is the active Next.js 16 app; run commands from the repo root, not a nested `frontend/` directory.
- The public site, API routes, and embedded Sanity Studio live together here. Studio is mounted at `/studio` via `sanity.config.ts` -> `src/sanity/sanity.config.ts`.
- Sanity holds public/editorial content only. The active Studio does not register the legacy `bookingSettings` schema. PostgreSQL through `src/lib/private-db`/Drizzle owns operational public service-booking configuration and catalog data, plus private form/contact, marketing, consent, checkout, payment, booking hold, and training enrollment data.

## Commands agents usually need

- Install: `npm install`.
- Dev server: `npm run dev`.
- Build: `npm run build` (`prebuild` runs `node scripts/validate-sanity-env.mjs`, so env/dataset alignment can fail before Next builds).
- Lint app code with `npm run lint`; Markdown files are ignored by the ESLint config.
- All Playwright E2E: `npm test`; focused browser test: `npx playwright test tests/<file>.spec.ts --project=chromium`.
- Unit tests use Node's runner through `tsx`: `npm run test:unit` runs DB-disabled source tests plus script tests, `npm run test:unit:db` runs DB-dependent source tests against `TEST_DATABASE_URL`, and `npm run test:unit:all` runs both scopes. Run one source file with `npx tsx --test src/path/to/file.test.ts`.
- DB migrations: generate with `npm run db:generate`; inspect target lineage with `npm run db:check`; apply with `npm run db:migrate` only after setting `PRIVATE_DB_MIGRATION_TARGET` and the exact `PRIVATE_DB_MIGRATION_HOST` for the current `DATABASE_URL`. Production also requires `PRIVATE_DB_MIGRATION_CONFIRM=production`.
- Sanity schema deploys are source-driven: edit `src/sanity/schemas/**`, then run `npx sanity schema deploy`.

## Environment and deploy gotchas

- Sanity project is `3auncj84`; API version default is `2026-03-24`.
- Dataset rules are enforced by `scripts/validate-sanity-env.mjs`: preview/staging expects `NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10`; production expects `production`.
- `sanity.cli.ts` targets `NEXT_PUBLIC_SANITY_DATASET` and refuses production schema operations unless `SANITY_SCHEMA_DEPLOY_TARGET=production` is set.
- Payment mock mode is server-only: `PAYMENT_GATEWAY_MODE=mock` is for local/dev flows and is rejected in production. Request controls are `x-lash-payment-mock-scenario` and `mockPaymentScenario` only when mock mode is enabled.
- Service bookings use Square when `SERVICE_BOOKING_SQUARE_ENABLED=true`; exposing the public direct-payment config/form also requires `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true`. The active UI uses direct `CHARGE_AND_STORE` payment and does not fall back to hosted checkout when that config is unavailable. Product and training checkout use the Square Web Payments SDK when `SQUARE_COMMERCE_ENABLED=true`. All Square events (product, training, and service booking) arrive on the single webhook at `/api/webhooks/square`; hosted service-payment returns/webhooks exist only to reconcile historical sessions. Historical Helcim records remain readable through the retained `helcim` enum value and generic provider fields, but the `helcim_*` columns have been dropped and no code path creates new Helcim payments.
- Operational Calendar connections are initiated from `/admin/calendar-connections` or `/admin/my-calendar`; credentials are encrypted with `BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY` and stored in PostgreSQL. The `BOOKING_ADMIN_SETUP_SECRET`/global Redis-token flow is legacy compatibility only; do not share its setup URL or paste it in tickets or chat. Redis still stores short-lived OAuth state and locks.
- Before branch creation, push, or PR, verify `git remote -v`; canonical remote is `https://github.com/princessdardan/lash-her-frontend.git`. `npm run git:push-staging` expects the `origin` remote to point there.

## Code paths that matter

- Public routes: `src/app/(site)`. Global shell/metadata: `src/app/layout.tsx` and `src/app/(site)/layout.tsx`. `/booking` is a legacy redirect shim; canonical booking pages are `/services/[slug]/booking`.
- All Sanity reads should go through `src/data/loaders.ts`; do not add a parallel data access layer.
- Sanity clients are purpose-specific: read client in `src/sanity/lib/client.ts`, write client in `src/sanity/lib/write-client.ts`; private form/contact writes belong in PostgreSQL, not Sanity.
- CMS block additions must be wired across schema, TypeScript shape/union (`src/types/index.ts`), GROQ projection (`src/data/loaders.ts`), React component, and `COMPONENT_REGISTRY` in `src/components/custom/layouts/block-renderer.tsx`.
- Cache tags in `src/data/loaders.ts` must stay aligned with `TYPE_TAG_MAP` in `src/app/api/revalidate/handler.ts`.
- Revalidation must use `parseBody()` from `next-sanity/webhook` before consuming the request body and `revalidateTag(tag, { expire: 0 })` for Next 16 immediate expiry.
- Booking/payment state lives mostly under `src/lib/booking`, `src/lib/commerce`, `src/app/api/booking`, `src/app/api/checkout`, and `src/app/api/webhooks`.

## Project-specific constraints

- Never store new PII, transaction history, payment tokens, or live form submissions in Sanity; write private records first, then send email as a non-blocking side effect.
- Direct booking creation is intentionally disabled; appointment confirmation happens after secure payment reconciliation.
- Tailwind v4 is CSS-first in `src/app/globals.css` with `@theme`; there is no `tailwind.config.*`.
- React Compiler is enabled in `next.config.ts`; avoid patterns that depend on mutation during render.
- Redirects in `next.config.ts`: `/homepage` -> `/`, `/training` -> `/training-programs`.
- Use `@/*` imports for `src/*` app code.

## Design guidance

- Treat `docs/lash-her-brand-kit.html` and current tokens in `src/app/globals.css` as the visual source of truth.
- Brand tone is quiet luxury/editorial restraint. Avoid generic beauty-site pinks, glitter/neon effects, crowded badges, and loud CTA treatments.

## Tests and evidence

- Route-handler and service tests live beside source under `src/**/*.test.ts`; Playwright specs live in `tests/` and auto-start `npm run dev` on port 3000.
- Existing Playwright mocks may not prove live Sanity/private-DB data flow. For production readiness, pair tests with the smoke matrix in `README.md`/`docs/launch-readiness-checklist.md`.
- Scheduled endpoint ownership, bearer-secret requirements, and fail-closed behavior are documented in `docs/scheduled-jobs-runbook.md`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
