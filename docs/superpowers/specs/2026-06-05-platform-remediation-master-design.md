# Platform Remediation Master Design

**Source:** docs/platform-comprehensive-after-action-review.md  
**Date:** 2026-06-05  
**Platform:** Lash Her by Nataliea — Next.js 16 + Sanity + PostgreSQL

---

## Overview

This master design consolidates the platform-wide remediation work identified in the 2026-06-05 After Action Review (AAR). It replaces the prior per-category design documents with a single coherent specification and seven implementation plans (one per AAR category). All implementation work must trace back to this document and the AAR.

| Category       | AAR Score | Target Score | Severity |
| -------------- | --------- | ------------ | -------- |
| Security       | 3 / 10    | 8 / 10       | CRITICAL |
| Architecture   | 4 / 10    | 7 / 10       | HIGH     |
| Performance    | 4 / 10    | 7 / 10       | HIGH     |
| Accessibility  | 3 / 10    | 8 / 10       | CRITICAL |
| DevOps         | 2 / 10    | 7 / 10       | CRITICAL |
| Testing        | 4 / 10    | 7 / 10       | HIGH     |
| Best Practices | 5 / 10    | 7 / 10       | MEDIUM   |

---

## Source AAR Issue Mapping

| ID  | Category       | Issue                                                                                                     | Severity | Evidence Location                                                                                                                                                                                        |
| --- | -------------- | --------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Security       | Public endpoints lack durable abuse controls                                                              | CRITICAL | `src/app/actions/form.ts:57-74`; `src/app/api/checkout/route.ts:180-207`; `src/app/api/booking/holds/route.ts:86-100`                                                                                    |
| 1.2 | Security       | Missing centralized security headers / CSP                                                                | CRITICAL | `next.config.ts:3-28`; no `src/middleware.ts`                                                                                                                                                            |
| 1.3 | Security       | CMS-authored link sanitization is inconsistent                                                            | HIGH     | `src/app/main-menu.tsx:14-16`; `src/components/ui/portable-text-renderer.tsx:24-31`; `src/components/custom/layouts/feature-section.tsx:79`                                                              |
| 1.4 | Security       | Google Calendar refresh token stored in KV plaintext                                                      | CRITICAL | `src/lib/booking/operational-store.ts:7,31-37`; `src/app/api/booking/oauth/callback/route.ts:23-33`                                                                                                      |
| 1.5 | Security       | Input payload size / string / array limits inconsistent                                                   | MEDIUM   | `src/app/api/booking/holds/route.ts:86-100`; `src/app/actions/form.ts:23-50`                                                                                                                             |
| 1.6 | Security       | Dependency vulnerabilities from `npm audit`                                                               | HIGH     | `package.json:24-75` — 22 moderate vulnerabilities                                                                                                                                                       |
| 1.7 | Security       | Local secret hygiene risk                                                                                 | CRITICAL | `.env.local` in working tree with 11 secret-bearing names                                                                                                                                                |
| 2.1 | Architecture   | External provider artifacts created before durable pending order                                          | HIGH     | `src/app/api/checkout/route.ts:180-207`; `src/app/api/training-checkout/route.ts:146-198`                                                                                                                |
| 2.2 | Architecture   | Payment finalization and side effects inline on user/webhook paths                                        | HIGH     | `src/app/api/checkout/validate-payment/route.ts:138-153`; `src/app/api/webhooks/card-transactions/route.ts:111-139`                                                                                      |
| 2.3 | Architecture   | Global site shell mounts heavy client components on every page                                            | HIGH     | `src/app/(site)/layout.tsx:29-39`; `src/components/custom/contact-popup/contact-popup.tsx:1-13`                                                                                                          |
| 2.4 | Architecture   | Static block registry limits code splitting                                                               | HIGH     | `src/components/custom/layouts/block-renderer.tsx:1-14`; `:30-41` eager imports                                                                                                                          |
| 3.1 | Performance    | Postgres pool lacks explicit serverless connection budget/timeouts                                        | HIGH     | `src/lib/private-db/client.ts:18-24`; `src/lib/private-db/pool-config.ts:3-13`                                                                                                                           |
| 3.2 | Performance    | Booking availability fans out to Sanity/DB/Google Calendar; global calendar lock bottlenecks finalization | HIGH     | `src/app/api/booking/availability/route.ts:119-162`; `src/lib/booking/operational-store.ts:8,39-53`                                                                                                      |
| 3.3 | Performance    | Image/bundle optimization gaps                                                                            | HIGH     | `src/components/ui/sanity-image.tsx:31-42`; `src/components/custom/layouts/hero-carousel.tsx:58-65`; build output ~8.9 MB                                                                                |
| 3.4 | Performance    | Layout-triggering animations and unbatched scroll state                                                   | HIGH     | `src/components/custom/training-detail-items.tsx:107-120`; `src/components/custom/layouts/hero-carousel.tsx:117-118`; `src/components/custom/layouts/header-wrapper.tsx:20-32`                           |
| 4.1 | Accessibility  | `SanityImage` defaults alt to empty; schema image alt often optional                                      | CRITICAL | `src/components/ui/sanity-image.tsx:36`; `src/sanity/schemas/documents/product.ts:203`; `src/sanity/schemas/documents/service.ts:100/120/131`; `src/sanity/schemas/objects/layout/hero-section.ts:31/83` |
| 4.2 | Accessibility  | Auto-rotating carousel and contact popup ignore reduced motion                                            | CRITICAL | `src/components/custom/layouts/hero-carousel.tsx:35-40`; `src/components/custom/contact-popup/contact-popup.tsx:39-48`                                                                                   |
| 4.3 | Accessibility  | Booking loading state lacks live region                                                                   | HIGH     | `src/components/booking/booking-flow.tsx:362-363`                                                                                                                                                        |
| 4.4 | Accessibility  | Basic a11y test has false negatives; no axe-core integration                                              | HIGH     | `tests/utils/test-helpers.ts:54-62`; no `@axe-core/playwright` in devDependencies                                                                                                                        |
| 5.1 | DevOps         | No repo-visible CI/CD workflow or enforced quality gates                                                  | CRITICAL | No `.github/**` files; `vercel.json:1-8`; `package.json:5-22`                                                                                                                                            |
| 5.2 | DevOps         | Console-heavy logging without structured observability/alerting                                           | HIGH     | `console.warn/error` in API routes; no Sentry/OTel dependencies                                                                                                                                          |
| 5.3 | DevOps         | Backup/DR runbooks exist but proof is manual                                                              | MEDIUM   | `docs/production-cutover-checklist.md` has backup/PITR placeholders                                                                                                                                      |
| 5.4 | DevOps         | Artifact hygiene: ignored tarballs and `.playwright-mcp` logs                                             | HIGH     | Root tarballs; tracked `.playwright-mcp/*` files                                                                                                                                                         |
| 6.1 | Testing        | Coverage not instrumented                                                                                 | HIGH     | `package.json:14`; no `c8`/`nyc` scripts                                                                                                                                                                 |
| 6.2 | Testing        | Skipped/weak tests                                                                                        | HIGH     | `tests/gallery.spec.ts:63`; conditional blocks without assertions                                                                                                                                        |
| 6.3 | Testing        | E2E/security/performance not required by visible CI                                                       | HIGH     | No `.github/**` files; `playwright.config.ts` not wired to CI                                                                                                                                            |
| 6.4 | Testing        | Lint warnings remain                                                                                      | LOW      | `npm run lint` — 7 warnings in `cta-section-image.tsx`, `cart-storage.ts`, `gallery.spec.ts`                                                                                                             |
| 7.1 | Best Practices | Legacy migration script is stale and high-blast-radius                                                    | MEDIUM   | `scripts/migrate-strapi-to-sanity.ts:1-17`; references missing `npm run migrate`; imports `qs` not in deps                                                                                               |
| 7.2 | Best Practices | Consent drift: Speed Insights loads outside consent-gated analytics                                       | HIGH     | `src/components/analytics/consented-analytics.tsx:14-52`; `src/app/layout.tsx:73-74` always loads `SpeedInsights`                                                                                        |
| 7.3 | Best Practices | Sanity schema validation is uneven for route/checkout/a11y-critical fields                                | MEDIUM   | `src/sanity/schemas/documents/product.ts:203`; `src/sanity/schemas/documents/service.ts:100/120/131`; `src/sanity/schemas/objects/layout/hero-section.ts:31/83`                                          |

---

## Target State

### Security

Abuse is blocked at the edge with durable KV token-bucket rate limiting, replay-protected signed nonces, hardened per-request CSP with nonces and reporting, strict CMS link allowlists with schema+component+audit enforcement, encrypted short-lived calendar access tokens, global request guards, automated dependency patching, and vault-driven secret hygiene.

### Architecture

Checkout routes are fast and durable: they write a pending order and an outbox event in a single PostgreSQL transaction, then return immediately while a background worker calls external providers. Payment webhooks publish domain events; idempotent consumers handle email, calendar, and analytics off the critical path. The public site shell becomes a server component with interactive islands hydrating on demand. CMS block components are lazy-loaded with route-aware preload hints.

### Performance

Database connections are managed through a proxy-aware pool configuration. Booking finalization uses a reservation saga with DB row-level locking and compensation, eliminating the global KV calendar lock. Images are responsive with `srcSet`, `next/image`, and LQIP placeholders. Animations run on the compositor thread only; scroll handlers are batched with `requestAnimationFrame` and respect `prefers-reduced-motion`.

### Accessibility

All images require meaningful alt text via schema rules, fallback chains, and optional AI-assisted generation. Auto-rotating carousels are replaced by a static editorial hero. Async loading/error states are announced through a reusable `AsyncState` wrapper. Automated axe-core scans run in CI and gate merges; manual audits and user testing are scheduled.

### DevOps

Every PR runs lint, unit tests, security audit, build, and E2E against a Vercel preview URL. Structured JSON logs and OpenTelemetry traces feed an observable backend with actionable alerts. Backups are validated weekly by an automated restore job; quarterly chaos drills measure RTO. Repository hygiene is enforced by pre-commit hooks and periodic history cleanup.

### Testing

Unit tests produce coverage reports with `c8` and Codecov; coverage regressions block merge. Stryker mutation tests run weekly to prove test effectiveness. A quality dashboard tracks coverage, duplication, and complexity. Lint warnings and skipped tests are zeroed out and kept at zero by CI gates and pre-commit hooks.

### Best Practices

Legacy migration scripts are archived with a documented runbook and token lockdown. Third-party performance tools are replaced by a first-party `PerformanceObserver` beacon feeding a `/api/metrics` endpoint using a `value` field (FID is not collected). A Sanity editorial guidance plugin surfaces real-time badges and blocks publish when critical fields are missing.

---

## Scope

### In Scope

- Edge middleware, CSP builder, rate limiting, request guard, signed nonces, link resolver, token vault, dependency automation, secret scanning.
- Outbox/event-sourcing schema and workers, checkout/webhook refactor, server-component shell, islands, dynamic block imports, block manifest generator.
- Pool configuration and connection proxy guidance, reservation saga, calendar sync worker, responsive image refactoring, compositor-only animations, reduced-motion hook.
- Static hero block, alt text generation plugin, `AsyncState` wrapper, axe-core E2E, manual audit runbooks, user testing templates.
- GitHub Actions CI workflows, preview-deployment E2E, structured logging, OpenTelemetry instrumentation, alerting rules, backup validation cron, chaos drill script, pre-commit hooks, BFG history cleanup.
- `c8` coverage, Codecov, Stryker, SonarQube/Code Climate, test-quality ESLint plugin, skipped-test and zero-warnings CI gates.
- Migration script archival, self-hosted performance beacon, metrics ingestion endpoint, editorial guidance plugin, schema validation tests.

### Out of Scope

- Network-layer WAF/DDoS changes (Vercel managed), full DAST/penetration testing, PCI-DSS compliance audit, RBAC or user authentication system, full SSRF allowlist for all external providers.
- Message bus (Kafka/RabbitMQ/SQS), microservices decomposition, edge rendering/SSR beyond current Next.js usage, CSS-in-JS migration.
- Full CDN migration (Cloudflare Images/Imgix), service worker caching, HTTP/3 or QUIC optimization, deep database query optimization beyond pooling.
- Braille/tactile output, sign language video, cognitive accessibility beyond current readability, property-based testing, visual regression testing, dedicated load/fuzz testing infrastructure.
- GDPR/CCPA compliance audit (legal effort), content migration from other platforms, custom analytics dashboard beyond a simple protected internal route or Grafana.

---

## Cross-Cutting Dependencies

| Dependency                                                                     | Impacts                                                                                                                      | Resolution                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI workflow (`.github/workflows/ci.yml`)                                       | Security audit gate, Testing coverage/quality gates, Accessibility axe CI gate, DevOps preview E2E                           | Build the CI workflow in DevOps Phase 0; downstream plans add jobs to it rather than creating parallel pipelines.                                             |
| Middleware + CSP nonce (`src/middleware.ts`, `src/lib/security/csp-policy.ts`) | Security headers; Architecture islands that inject inline scripts must read the nonce via `headers()`                        | Security plan creates middleware first; Architecture plan consumes the nonce header in layouts.                                                               |
| Global request guard (`src/lib/security/request-guard.ts`)                     | Security boundary; also wraps public POST routes used by Performance/Architecture checkout and Best-practices `/api/metrics` | Created in Security Phase 1; reused by other categories.                                                                                                      |
| Outbox/events tables (`outbox`, `events`, `processedEvents`)                   | Architecture provider calls; Performance calendar saga; DevOps alerting on queue depth                                       | Created in Architecture Phase 1; Performance and DevOps plans depend on it.                                                                                   |
| Private DB schema migrations                                                   | Performance reservations; Architecture outbox; Best-practices `performance_metrics`                                          | Any plan adding tables runs `npm run db:generate && npm run db:migrate` and gates on clean baselines.                                                         |
| Sanity schema deploys                                                          | Security link validation; Accessibility alt requirements; Best-practices editorial plugin                                    | Source-driven under `src/sanity/schemas/**`; deploy to staging with `npx sanity schema deploy`; production requires `SANITY_SCHEMA_DEPLOY_TARGET=production`. |
| Structured logger (`src/lib/logging/logger.ts`)                                | DevOps observability; consumed by API routes touched in Security/Architecture/Performance                                    | Created in DevOps Phase 4; plans that add/modify API routes should replace `console.*` with `log()`.                                                          |
| `useReducedMotion` hook                                                        | Performance animation behavior; Accessibility carousel/popup motion                                                          | Created where first needed and reused across plans.                                                                                                           |

---

## Architecture Approach

### Security: Layered Defense

```
Edge (middleware) → Rate limiter (KV token bucket) → Request guard → Business logic → Secret/dependency hygiene
```

- Edge: UA validation, nonce generation, HSTS, CSP, Permissions-Policy.
- Rate limiter: composite `route:ip:nonce` keys, tiered limits, graceful KV degradation.
- Request guard: body size, string length, array length, object depth limits.
- Business logic: HMAC-signed nonces, CMS link resolver, token vault integration.
- Hygiene: Renovate, CI audit gate, detect-secrets, 1Password/Doppler local workflow.

### Architecture: Outbox + Event Sourcing + Islands

- Checkout route writes `pending` order + `outbox` event in one transaction; cron worker processes outbox.
- Webhook validates signature, publishes `payment_confirmed` event, returns 200 immediately; idempotent consumers handle side effects.
- Site layout becomes a server component; `CartButtonIsland` and `ContactTriggerIsland` hydrate on interaction.
- Block renderer switches to per-type dynamic imports; a build-time script emits `public/block-manifest.json` for preload hints.

### Performance: Proxy Pool + Saga + Compositor Motion

- Proxy-aware pool config reduces application `max` to 2–3 when using PgBouncer/Supabase Pooler.
- Booking holds insert a `reservations` row with `status = 'held'`; a cron syncs to calendar and transitions to `confirmed` or compensates to `released`.
- `SanityImage` emits `srcSet` and wraps `next/image` with a custom loader; LQIP placeholders use Sanity `?blur=10&w=100`.
- Animations use `transform` and `opacity` only; scroll handlers batch reads with `requestAnimationFrame`; reduced motion disables non-essential animation.

### Accessibility: Static Hero + AsyncState + Alt Pipeline

- Carousel deprecated and replaced by a static server-rendered hero block.
- Booking/checkout/form async states wrap `AsyncState` with `aria-live`, `aria-busy`, focus management.
- Alt generation service uses Google Cloud Vision; a Sanity document action lets editors trigger or override generation; existing images are batch-processed; schemas require alt.
- axe-core runs in CI on `/`, `/services`, `/training-programs`, `/contact`; manual audits quarterly; user testing semi-annually.

### DevOps: GitOps + Observability + DR

- GitHub Actions: lint/unit/audit/build on every PR; preview deploy via Vercel action; E2E against preview URL using `playwright.preview.config.ts` with `webServer: undefined`; branch protection requires all checks.
- Structured JSON logging and OpenTelemetry auto-instrumentation export to Honeycomb/Datadog.
- Alerts: 5xx rate, webhook failure rate, outbox queue depth, p95 latency.
- Weekly cron restores latest backup to staging and runs health check; quarterly chaos drill script measures RTO against a dedicated restore database.
- Pre-commit hooks block large files and secrets; BFG purges history after team coordination.

### Testing: Coverage + Mutation + Quality Dashboard

- `c8` produces LCOV; Codecov posts PR comments; CI blocks coverage drops > 1%.
- Stryker runs weekly off-peak; target mutation score increases quarterly.
- SonarQube Cloud tracks coverage, duplication, complexity, and security hotspots.
- `eslint-plugin-jest-playwright` enforces assertions; CI enforces zero lint warnings and zero skipped tests.

### Best Practices: Archive + First-Party Metrics + Editorial Guidance

- `scripts/migrate-strapi-to-sanity.ts` moves to `scripts/archive/`; `docs/runbooks/migration.md` records approval workflow, token IP restrictions, MFA, and rotation schedule.
- `SpeedInsights` removed; `initSelfHostedMetrics()` sends beacons to `/api/metrics` using a `value` field; allowed metrics exclude FID.
- Editorial guidance plugin shows badges and disables publish when critical fields are missing; schema validation tests verify required fields exist.

---

## Rollout Sequencing

Remediation is organized into five phases. Phases can overlap where dependencies are satisfied.

### Phase 0 — Foundation (Week 1)

- DevOps: Remove tracked tarballs/`.playwright-mcp` files; set up pre-commit hooks; create baseline CI (lint, unit, audit, build).
- Testing: Fix remaining lint warnings in `eslint.config.mjs`, `src/components/custom/layouts/cta-section-image.tsx`, `src/lib/commerce/cart-storage.ts`; fix or delete skipped tests; add `c8` coverage script.
- Performance: Update pool config with explicit limits.
- Best Practices: Archive stale migration script; document runbook; configure Sanity token IP restrictions.
- Security: Verify `.env.local` is ignored; establish detect-secrets baseline.

### Phase 1 — Shared Infrastructure (Week 2)

- Security: Middleware, CSP report-only mode, request guard.
- Architecture: Outbox table + checkout route refactor; webhook event publishing; remove inline provider side effects from user-facing paths after tests cover the new outbox/status flow.
- Accessibility: `AsyncState` wrapper; reduced-motion hook; static hero component and schema variant.
- DevOps: Preview deploy job + E2E against preview URL; branch protection.

### Phase 2 — Runtime Hardening + Core Refactor (Weeks 3–4)

- Security: KV rate limiter; signed nonces; link resolver + audit script + schema validation; encrypted calendar token vault.
- Architecture: Event consumers; cron workers; site layout conversion to server component with islands.
- Performance: Connection proxy cutover; booking reservation saga; calendar sync worker.
- Accessibility: Deploy schema requiring alt on product/service/hero images.

### Phase 3 — UX + Bundle Optimization (Weeks 5–6)

- Performance: Responsive `SanityImage`; LQIP placeholders; animation refactor; `requestAnimationFrame` scroll batching.
- Architecture: Dynamic block imports; block manifest generator; preload hints.
- Accessibility: Alt generation service and Sanity plugin; batch-process existing images.
- Best Practices: Self-hosted performance beacon; `/api/metrics` endpoint; protected metrics dashboard.

### Phase 4 — Observability + Quality Automation (Weeks 7–9)

- DevOps: Structured logging; OpenTelemetry instrumentation; alerting rules; backup validation cron; chaos drill script; BFG history purge.
- Testing: Codecov integration; Stryker weekly run; SonarQube Cloud; test-quality ESLint plugin; zero-warnings/skipped-tests gates.
- Accessibility: axe-core CI gate; schedule manual audit and user testing.
- Best Practices: Editorial guidance plugin; schema validation tests.
- Security: Renovate auto-merge; CI audit gate hardening.

---

## Acceptance Criteria Summary

### Security

- `POST /api/checkout` returns `429` after 10 requests/minute per IP.
- Staging serves `Content-Security-Policy-Report-Only`; production serves enforced CSP with nonces.
- `javascript:alert(1)` in a CMS link renders as a non-clickable span.
- No plaintext refresh token in KV; calendar sync still works after token expiry.
- `POST` with `Content-Length: 70000` returns `413`.
- Zero moderate+ vulnerabilities on `main` via Renovate + audit gate.
- `.env.local` untracked; local dev uses vault CLI workflow.

### Architecture

- Checkout route writes pending order + outbox event in one transaction and returns within 200 ms.
- Webhook returns `200` within 100 ms of validation.
- Duplicate webhooks produce exactly one email and one calendar event.
- Static pages ship < 50 KB client JS (excluding analytics).
- `public/block-manifest.json` exists after build; only blocks on the page load.

### Performance

- Application pool `max` is 2–3 when proxy is active; ≤ 20 DB connections under load.
- Hold endpoint inserts reservation and returns within 100 ms; duplicate slots return `409`.
- `SanityImage` renders `srcSet` with 320–2560 widths; Lighthouse "Properly size images" score ≥ 90.
- No purple "Layout" bars in DevTools Performance panel during scroll or expand/collapse.

### Accessibility

- Homepage uses static hero; no auto-rotation.
- `prefers-reduced-motion: reduce` disables non-essential animations.
- Screen reader announces loading and errors in booking/checkout/forms via `AsyncState`.
- axe-core CI passes with zero violations on `/`, `/services`, `/training-programs`, `/contact`.

### DevOps

- CI runs on every PR with lint, unit, audit, build, and preview-E2E jobs.
- Branch protection requires all checks.
- Structured logs and OTel traces visible in backend dashboard.
- Alerts trigger within 2 minutes of synthetic failure.
- Weekly backup restore validation passes; quarterly chaos drill measures RTO.
- BFG history purge removes blobs > 1 MB.

### Testing

- `npm run test:unit:coverage` generates LCOV; Codecov posts PR delta.
- Stryker runs weekly and produces a report.
- SonarQube dashboard shows coverage, duplication, and complexity trends.
- `npm run lint -- --max-warnings=0` passes; zero skipped tests on `main`.

### Best Practices

- Stale migration script archived; runbook documented and < 6 months old.
- `SpeedInsights` removed; self-hosted metrics active; payload uses `value`, FID not collected.
- Editorial plugin shows badges and blocks publish for missing title/slug/alt.
- Schema validation tests pass.

---

## Validation Matrix Summary

| Category       | Key Verification      | Command / Method                                                                                                                                                                                               |
| -------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------- |
| Security       | Headers on staging    | `curl -I "$STAGING_BASE_URL/"`                                                                                                                                                                                 |
| Security       | Rate limiting         | `for i in {1..12}; do curl -X POST /api/checkout -d '{}'; done`                                                                                                                                                |
| Security       | Payload guard         | `curl -X POST /api/booking/holds -H "Content-Length: 70000" -d '{}'`                                                                                                                                           |
| Security       | Secret scan           | `detect-secrets scan --all-files`                                                                                                                                                                              |
| Security       | Audit gate            | `npm audit --audit-level=moderate`                                                                                                                                                                             |
| Architecture   | Outbox depth          | `psql $DATABASE_URL -c "SELECT COUNT(*) FROM outbox WHERE status = 'pending';"`                                                                                                                                |
| Architecture   | Webhook latency       | Measure POST `/api/webhooks/card-transactions` response time                                                                                                                                                   |
| Architecture   | Bundle size           | `npm run build` + network tab / `next-bundle-analyzer`                                                                                                                                                         |
| Performance    | DB connections        | `psql $DATABASE_URL -c "SELECT COUNT(*) FROM pg_stat_activity WHERE state = 'active';"`                                                                                                                        |
| Performance    | Booking hold latency  | `autocannon -c 10 -d 30 -m POST /api/booking/holds`                                                                                                                                                            |
| Performance    | Lighthouse            | `npx lighthouse http://localhost:3000/ --output=json`                                                                                                                                                          |
| Performance    | Animation profiling   | Chrome DevTools Performance panel (no purple Layout bars)                                                                                                                                                      |
| Accessibility  | axe scan              | `npx playwright test tests/a11y.spec.ts`                                                                                                                                                                       |
| Accessibility  | Alt coverage          | `curl -s http://localhost:3000/                                                                                                                                                                                | grep -o '<img[^>]\*>' | grep -v 'alt='` |
| DevOps         | CI status             | GitHub Actions UI on PR                                                                                                                                                                                        |
| DevOps         | Log format            | Inspect Vercel logs for JSON lines                                                                                                                                                                             |
| DevOps         | Backup restore        | Weekly cron result + `pg_restore` + health query                                                                                                                                                               |
| Testing        | Coverage              | `npm run test:unit:coverage`                                                                                                                                                                                   |
| Testing        | Lint                  | `npm run lint -- --max-warnings=0`                                                                                                                                                                             |
| Testing        | Skipped tests         | `grep -r "test.skip\|it.skip\|describe.skip" tests/ src/`                                                                                                                                                      |
| Best Practices | SpeedInsights removed | `grep -r "SpeedInsights" src/app/layout.tsx` returns nothing                                                                                                                                                   |
| Best Practices | Metrics endpoint      | `curl -X POST /api/metrics -H "Content-Type: application/json" -d '{"name":"LCP","value":1200,"type":"web-vital","path":"/checkout?email=test@example.com#token"}'` then verify the stored path is `/checkout` |
| Best Practices | Studio guidance       | Manual Studio verification of badge + publish blocking                                                                                                                                                         |

---

## Risks and Backout

| Risk                                                      | Impact | Mitigation                                                                           |
| --------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| CSP breaks third-party scripts or Sanity Studio           | HIGH   | Stage with `Report-Only` for at least 2 weeks; monitor violation reports daily.      |
| KV rate limiter failure blocks checkout                   | HIGH   | Graceful degradation: log warning and allow request if KV is unavailable.            |
| Connection proxy incompatibility with prepared statements | MEDIUM | Test all queries in staging before cutover; keep direct-connection rollback.         |
| Outbox/event worker duplication or loss of events         | HIGH   | Idempotent consumers with `processedEvents` table; `SELECT FOR UPDATE` where needed. |
| Islands break client context providers                    | MEDIUM | Verify booking/cart providers are inside client islands; run E2E before merge.       |
| Schema required fields block existing drafts              | MEDIUM | Notify content team before deploy; batch-fix legacy content in staging first.        |
| BFG history rewrite disrupts open branches                | HIGH   | Coordinate 1 week in advance; backup repository; provide rebase instructions.        |
| Renovate auto-merge introduces regressions                | MEDIUM | Auto-merge patch only; require human review for minor/major.                         |

### Common Backout Methods

- CSP enforcement → switch to `Report-Only` via env var.
- Rate limiter → set `RATE_LIMITING_ENABLED=false`.
- Middleware → rename `src/middleware.ts` to `src/middleware.ts.disabled`.
- Outbox checkout → revert route to inline provider call.
- Islands → restore eager client imports in layout.
- Connection proxy → revert `DATABASE_URL` to direct Postgres.
- Booking saga → re-enable global KV lock.

---

## Repo-Specific Constraints

All implementation work must respect the following constraints, which are derived from `AGENTS.md` and the AAR:

- **Sanity content boundary:** Sanity holds public/editorial content only. Private form/contact, marketing, consent, checkout, payment, booking hold, and training enrollment data belong in PostgreSQL through `src/lib/private-db`/Drizzle.
- **Schema changes:** Source-driven under `src/sanity/schemas/**`. Deploy with `npx sanity schema deploy`. Production schema deploy requires `SANITY_SCHEMA_DEPLOY_TARGET=production`.
- **Baseline validation commands for every change:**
  - `npm run lint`
  - `npm run test:unit`
  - `npm run build`
  - `npm test` (Playwright E2E)
- **Do not** store new PII, transaction history, payment tokens, or live form submissions in Sanity.
- **Payment mock mode** (`PAYMENT_GATEWAY_MODE=mock`) is server-only and rejected in production.
- **Helcim webhook URL** is `/api/webhooks/card-transactions` and must not contain the string `helcim`.
- **Sanity project:** `3auncj84`; default API version `2026-03-24`.
- **Dataset rules:** Preview/staging uses `NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10`; production uses `production`.
- **Booking creation:** Direct booking creation is intentionally disabled; appointment confirmation happens only after secure payment reconciliation.

---

## Plan Index

| Category       | Implementation Plan                                                        |
| -------------- | -------------------------------------------------------------------------- |
| Security       | `docs/superpowers/plans/2026-06-05-platform-security-remediation.md`       |
| Architecture   | `docs/superpowers/plans/2026-06-05-platform-architecture-remediation.md`   |
| Performance    | `docs/superpowers/plans/2026-06-05-platform-performance-remediation.md`    |
| Accessibility  | `docs/superpowers/plans/2026-06-05-platform-accessibility-remediation.md`  |
| DevOps         | `docs/superpowers/plans/2026-06-05-platform-devops-remediation.md`         |
| Testing        | `docs/superpowers/plans/2026-06-05-platform-testing-remediation.md`        |
| Best Practices | `docs/superpowers/plans/2026-06-05-platform-best-practices-remediation.md` |
