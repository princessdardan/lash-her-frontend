# AGENTS.md

## What this repo is

- Root package is the active Next.js 16 app; run commands from the repo root, not a nested `frontend/` directory.
- The public site, API routes, and embedded Sanity Studio live together here. Studio is mounted at `/studio` via `sanity.config.ts` -> `src/sanity/sanity.config.ts`.
- Sanity holds public/editorial content only. Private form/contact, marketing, consent, checkout, payment, booking hold, and training enrollment data belongs in PostgreSQL through `src/lib/private-db`/Drizzle.

## Commands agents usually need

- Install: `npm install`.
- Dev server: `npm run dev`.
- Build: `npm run build` (`prebuild` runs `node scripts/validate-sanity-env.mjs`, so env/dataset alignment can fail before Next builds).
- Lint app code with `npm run lint`; Markdown files are ignored by the ESLint config.
- All Playwright E2E: `npm test`; focused browser test: `npx playwright test tests/<file>.spec.ts --project=chromium`.
- Unit tests use Node's runner through `tsx`: all with `npm run test:unit`; focused file with `npx tsx --test src/path/to/file.test.ts`.
- DB migrations: generate with `npm run db:generate`; apply with `npm run db:migrate` against the current `DATABASE_URL`.
- Sanity schema deploys are source-driven: edit `src/sanity/schemas/**`, then run `npx sanity schema deploy`.

## Environment and deploy gotchas

- Sanity project is `3auncj84`; API version default is `2026-03-24`.
- Dataset rules are enforced by `scripts/validate-sanity-env.mjs`: preview/staging expects `NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10`; production expects `production`.
- `sanity.cli.ts` targets `NEXT_PUBLIC_SANITY_DATASET` and refuses production schema operations unless `SANITY_SCHEMA_DEPLOY_TARGET=production` is set.
- Payment mock mode is server-only: `PAYMENT_GATEWAY_MODE=mock` is for local/dev flows and is rejected in production. Request controls are `x-lash-payment-mock-scenario` and `mockPaymentScenario` only when mock mode is enabled.
- Service bookings use Square only when `SERVICE_BOOKING_SQUARE_ENABLED=true`; product and training checkout use Helcim. Helcim webhook URL is `/api/webhooks/card-transactions` and must not contain `helcim`.
- Booking OAuth setup uses the protected internal flow with `BOOKING_ADMIN_SETUP_SECRET` from the secure secret manager; do not share the setup URL or paste it in tickets or chat.
- Before branch creation, push, or PR, verify `git remote -v`; canonical remote is `https://github.com/princessdardan/lash-her-frontend.git`. `npm run git:push-staging` expects the `origin` remote to point there.

## Code paths that matter

- Public routes: `src/app/(site)`. Global shell/metadata: `src/app/layout.tsx` and `src/app/(site)/layout.tsx`.
- All Sanity reads should go through `src/data/loaders.ts`; do not add a parallel data access layer.
- Sanity clients are purpose-specific: read client in `src/sanity/lib/client.ts`, write client in `src/sanity/lib/write-client.ts`; private form/contact writes belong in PostgreSQL, not Sanity.
- CMS block additions must be wired across schema, TypeScript shape/union (`src/types/index.ts`), GROQ projection (`src/data/loaders.ts`), React component, and `COMPONENT_REGISTRY` in `src/components/custom/layouts/block-renderer.tsx`.
- Cache tags in `src/data/loaders.ts` must stay aligned with `TYPE_TAG_MAP` in `src/app/api/revalidate/route.ts`.
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
