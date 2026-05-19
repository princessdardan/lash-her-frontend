# Production Readiness Audit - Staging to Production

Date: 2026-05-16  
Branch context: `staging`  
Scope: Next.js app, Sanity CMS, training programs, ecommerce, Helcim checkout, booking, private database, forms, email, revalidation, infrastructure, testing, logging, and launch operations.

## Executive Summary

The codebase is close to a launchable architecture, but it is not ready for a low-risk production cutover without an operational hardening pass and live-environment smoke testing.

The strongest parts are the architectural boundaries: Sanity is used for public/editorial content, Helcim secrets stay server-side, sensitive checkout/form/marketing records are stored in private Postgres, Google Calendar remains the booking source of truth, and Sanity revalidation uses signed webhooks. The implementation also includes meaningful unit coverage for cart validation, payment verification, webhook signature handling, order storage, booking availability, and training enrollment state.

The main launch risks are not basic code shape problems. They are production operations gaps: environment parity, database migration/smoke-test discipline, live Helcim webhook verification, live Google OAuth and Calendar setup, remaining route-handler coverage, orphaned checkout record scenarios, stale documentation/env examples, placeholder structured data, and limited observability beyond console logs and Vercel defaults.

Recommended launch posture: do not promote staging to production until the critical checklist in this document is completed in a production-like staging environment with real staging credentials, real Sanity dataset, private database, Helcim test/live account settings, Upstash Redis, Google Calendar OAuth, and Resend sender/domain configuration.

## Evidence Sources

Primary implementation files inspected:

- `package.json`
- `.env.local.example`
- `README.md`
- `CLAUDE.md`
- `next.config.ts`
- `drizzle.config.ts`
- `playwright.config.ts`
- `src/data/loaders.ts`
- `src/sanity/env.ts`
- `src/lib/marketing-contact/*`
- `src/sanity/structure/index.ts`
- `src/app/actions/form.ts`
- `src/app/api/checkout/route.ts`
- `src/app/api/checkout/validate-payment/route.ts`
- `src/app/api/training-checkout/route.ts`
- `src/app/api/webhooks/card-transactions/route.ts`
- `src/app/api/revalidate/route.ts`
- `src/lib/commerce/*`
- `src/lib/booking/*`
- `src/lib/private-db/*`
- `scripts/validate-sanity-env.mjs`
- `scripts/migrate-private-db.ts`
- `drizzle/0000_old_moonstone.sql`
- `drizzle/0001_private_training_enrollments.sql`
- `drizzle/0002_rapid_fat_cobra.sql`
- `tests/*.spec.ts`
- `tests/utils/api-mocks.ts`

Primary docs and plans inspected:

- `docs/private-checkout-storage-setup.md`
- `docs/booking-helcim-implementation-summary.md`
- `docs/google-calendar-oauth-env-setup.md`
- `docs/sanity-staging-production-workflow.md`
- `docs/superpowers/specs/*`
- `docs/superpowers/plans/*`
- `.planning/milestones/v1.0-phases/*`
- `AGENTS.md`, `src/app/AGENTS.md`, `src/sanity/AGENTS.md`, `scripts/AGENTS.md`, `tests/AGENTS.md`

External best-practice baseline used:

- Next.js production deployment and App Router caching guidance.
- Sanity webhook validation and Next.js caching/revalidation guidance.
- Drizzle migration guidance: generated SQL migrations, tested in staging before production, avoid schema push-style workflows for production.
- Hosted checkout guidance: fulfill from verified server-side payment events/webhooks, not success-page navigation.
- Vercel env and observability guidance: separate envs, redeploy after env changes, runtime logs have limited retention unless drained.

## Readiness Scorecard

| Area | Status | Launch Risk |
| --- | --- | --- |
| Core Next.js architecture | Mostly ready | Medium |
| Sanity CMS and content workflow | Mostly ready | Medium |
| Cache revalidation | Mostly ready | Medium |
| Ecommerce product catalog | Mostly ready | Medium |
| Helcim checkout and payment verification | Partially ready | High |
| Training checkout and booking handoff | Partially ready | High |
| Private database modeling | Mostly ready | High until migrated/smoke-tested |
| Booking system | Partially ready | High until live OAuth/calendar tested |
| Forms and email | Mostly ready | Medium until private DB/Resend smoke-tested |
| Logging and observability | Not production-ready | High |
| Test coverage | Partially ready | High |
| Infrastructure/env parity | Not production-ready until manually verified | High |
| Launch runbooks | Partially ready | Medium |

## How The System Works Today

### Public App And CMS

The app is a root-level Next.js 16 App Router application. Public pages are server components and load CMS data through `src/data/loaders.ts`. Sanity is the content source for pages, global settings, navigation, training programs, sellable products, and booking settings. Form, contact, marketing, and consent submissions are private DB-backed; historical Sanity submission documents are backfill sources only.

Important loader behavior:

- `sanityFetchOptions()` disables caching on Vercel preview deployments and uses cache tags elsewhere.
- Page and singleton queries use tags such as `homePage`, `trainingProgram`, `sellableProduct`, `bookingSettings`, `global`, and `menu`.
- Product and training checkout flows re-read Sanity data server-side before creating checkout sessions.

Ideal launch behavior:

- Production uses `NEXT_PUBLIC_SANITY_DATASET=production`.
- Preview/staging uses `NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10`.
- Editors publish content in Sanity; signed webhooks call `/api/revalidate`; affected cache tags expire immediately.
- Public pages never read private checkout or form/contact PII records from Sanity.

Current concerns:

- `.env.local.example` still documents legacy Strapi and Vercel Blob/Motion registry values even though current guidance says Strapi is legacy and no private Motion registry token is required for deployment.
- `scripts/validate-sanity-env.mjs` protects Vercel production and preview dataset choices, but it only validates `NEXT_PUBLIC_SANITY_DATASET`, not the full set of production-critical env vars.
- The README is still mostly create-next-app boilerplate, with launch-critical setup appended later. It is not a complete operator runbook.

### Sanity Studio And Content Model

The embedded Studio is mounted under `/studio`. Schemas are code-defined under `src/sanity/schemas` and manually registered in `src/sanity/schemas/index.ts`. Studio navigation is customized in `src/sanity/structure/index.ts`.

Current Studio structure:

- Pages: home, contact, gallery, training, training programs overview, global settings, navigation menu.
- Booking: booking settings. Historical marketing opt-ins may exist as legacy/backfill records.
- Content: training programs and sellable products.
- Submissions: legacy/backfill-only general inquiries, training contact forms, contact popup submissions, and booking marketing opt-ins if those document types are still registered.

Good signs:

- Checkout orders are not exposed in Studio.
- Private checkout docs explicitly prohibit storing checkout PII, checkout tokens, Helcim invoice/transaction references, or reconciliation records in Sanity.
- `form-client.ts` and `write-client.ts` are separate server-only mutation clients.

Current concerns:

- `training-program.ts` contains a TODO for cross-document validation to ensure the selected checkout product is kind `training`. Runtime validation catches this in `src/lib/training-checkout.ts`, but editorial validation should prevent bad content before publish.
- Sanity token least privilege is limited by plan constraints. Historical docs state `SANITY_FORM_TOKEN` may need editor role on non-enterprise Sanity tiers. That token is not a current live form-write dependency if forms remain private DB-backed; retain it only for explicitly documented legacy/conditional Sanity submission work.

### Revalidation

`src/app/api/revalidate/route.ts` verifies Sanity webhook signatures using `parseBody()` from `next-sanity/webhook`, maps `_type` to a cache tag, and calls `revalidateTag(tag, { expire: 0 })`.

Good signs:

- Raw body is parsed before JSON, preserving signature validation.
- `isValidSignature !== true` rejects both invalid and missing-secret cases.
- Unknown document types no-op with a 200 response.
- Cache tags include booking settings and sellable products.

Ideal launch behavior:

- Sanity webhook projection is `{ _type }`.
- Webhook secret exactly matches `SANITY_WEBHOOK_SECRET` in the deployed environment.
- Production publishes are reflected quickly on production pages.
- Staging publishes affect only staging.

Current concerns:

- Automated route-handler tests now cover the core `/api/revalidate` signature and tag-mapping paths.
- Manual webhook testing is still required in staging and production.
- Logging is console-only; there is no structured event or alert if revalidation fails repeatedly.

### Ecommerce Product Catalog

Sellable product content is stored in Sanity as `sellableProduct`. The catalog supports products, services, training, and deposits through schema fields. Public catalog pages read from `src/data/loaders.ts`; cart behavior lives in `src/lib/commerce/cart.ts` and UI components under `src/components/commerce`.

Good signs:

- Server-side checkout rebuilds cart totals from Sanity products by ID rather than trusting client prices.
- Cart validation rejects empty carts, unavailable products, invalid quantities, missing variants, unavailable variants, unsupported currency, and mismatched products.
- Unit tests cover money and cart validation.

Ideal launch behavior:

- Editors maintain product availability, variants, SKUs, prices, and fulfillment copy in Sanity.
- Product pages and cart UI reflect Sanity catalog state.
- Checkout API uses only server-derived prices and line items.

Current concerns:

- First-release checkout intentionally does not include taxes, discounts, shipping, ACH, partial payments, refunds, saved payment methods, or customer pre-linking for general products. That is acceptable only if the business confirms those are not needed at launch.
- Product order confirmation email behavior is implemented in the current workstream, but it still requires live staging verification with Resend evidence before launch.

### Helcim Checkout And Payment Processing

There are two checkout entry points:

- `POST /api/checkout` for general cart checkout.
- `POST /api/training-checkout` for training program checkout.

Both routes create a Helcim invoice, initialize HelcimPay, store a pending private checkout record, and return only `checkoutToken` to the browser. The browser never receives the Helcim `secretToken` or API tokens.

Payment validation happens at `POST /api/checkout/validate-payment`. It retrieves the pending order by hashed checkout token, verifies the Helcim payload hash with the encrypted server-side secret token, checks approved status, transaction ID, amount, currency, and invoice identity, and marks the private order as paid.

Helcim webhooks are handled at `/api/webhooks/card-transactions`, intentionally avoiding the word `helcim` in the URL because the docs note Helcim dashboard restrictions. The route verifies signature headers and raw body, fetches card transaction details for reconciliation, stores idempotent payment events, marks matching orders paid, and can recover training payment notification emails.

Good signs:

- Separate Helcim general and transaction API tokens are used.
- Helcim API tokens are server-only env vars.
- Browser receives only `checkoutToken`.
- `secretToken` is encrypted before database storage using `CHECKOUT_SECRET_ENCRYPTION_KEY`.
- Webhook idempotency keys are unique in the private database.
- Payment verification failure marks the order `verification_failed`.
- Webhook payloads are redacted before storage.

Production-readiness gaps:

1. There is no transaction boundary around Helcim invoice/session creation and private DB persistence. If Helcim succeeds and database persistence fails, an orphan invoice/session can exist.
2. Training checkout creates a pending order and then creates a training enrollment. If enrollment creation fails, the pending order can exist without a training enrollment.
3. Route-handler unit tests now cover several checkout, training checkout, payment validation, webhook, and revalidation paths, but coverage should remain aligned with the critical API inventory below.
4. E2E checkout coverage mocks Helcim script and API routes. This is useful for UX behavior but does not prove live Helcim, database, webhook, or payment verification integration.
5. Webhook replay tolerance should be reviewed. The implementation allows a broad freshness window. If this matches Helcim requirements, document it; otherwise narrow it.

Recommendation:

- Keep Helcim for this launch only if staging can pass real end-to-end test transactions against the intended Helcim environment, including webhook delivery, validation, private DB state transitions, and email behavior.
- If the business wants lower operational risk and broader ecosystem support, consider migrating payment orchestration to a more standard hosted checkout provider such as Stripe Checkout for future work. Stripe has stronger documented fulfillment/webhook patterns, better local tooling, and wider operational familiarity. This is not required for launch if Helcim is already the business choice, but it is the safer long-term alternative.

### Training Programs And Paid Booking Handoff

Training programs live in Sanity as `trainingProgram`. A training program can enable checkout and reference a `sellableProduct` of kind `training`. The runtime checkout guard in `src/lib/training-checkout.ts` requires:

- checkout enabled,
- checkout product present,
- product kind `training`,
- product available,
- currency CAD,
- valid positive price,
- no variants/options for training checkout,
- client price, if provided, matches server price.

Training checkout calculates Ontario HST at 13 percent, creates a one-line Helcim invoice, stores the private pending order, and creates a `training_enrollments` row.

After payment validation, confirmation links route to `/training-programs/[slug]/confirmation?order=...`, and scheduling links route to `/booking?type=training-call&order=...`. The public booking flow rejects legacy raw scheduling-token links.

The booking service resolves the paid training order against private paid enrollment state, ensures the booking email matches the checkout email, forces the paid training booking type, inserts a Google Calendar event, and marks the enrollment scheduled.

Good signs:

- Training purchase and booking are intentionally separated: payment does not directly create a calendar event.
- Paid booking context enforces email matching against private order/enrollment state.
- No customer-facing booking flow depends on raw scheduling tokens.
- Booking creation revalidates availability immediately before calendar insertion.

Production-readiness gaps:

- The training checkout order/enrollment split needs atomicity or a cleanup/reconciliation plan.
- Editorial validation should prevent non-training sellable products from being attached to training programs.
- Live booking handoff must be manually tested with real Google OAuth, Redis, Calendar availability markers, payment success, order-based booking link, checkout-email mismatch rejection, and calendar event creation.

### Booking System

The booking system uses Sanity for configurable booking settings, Google Calendar as the source of truth for availability and confirmed bookings, Upstash Redis for OAuth refresh token storage, whole-calendar locking, and idempotency, and Resend for booking confirmation email.

Good signs:

- OAuth setup is protected by `BOOKING_ADMIN_SETUP_SECRET`.
- Google refresh token is stored server-side in Upstash Redis, not in source code or Sanity.
- Slot creation revalidates availability server-side.
- Calendar lock reduces double-booking race conditions.
- Idempotency keys reduce duplicate submissions.
- Email failures do not roll back successful bookings.

Intentional non-goals documented:

- No booking payments.
- No Google Meet links.
- No cancellation/rescheduling.
- No approval workflow.
- No multiple staff calendars.
- No persisted booking history in Sanity.

Production-readiness gaps:

- Live OAuth and Calendar setup cannot be inferred from code. It must be verified in staging and production.
- Calendar lock TTL is 20 seconds. This is probably enough for normal requests, but launch testing should confirm Google API latency does not exceed it under real conditions.
- There is no external alert if booking email, Redis, or Google Calendar calls begin failing.

### Forms And Email

General inquiry, training contact, and contact popup forms submit through server actions in `src/app/actions/form.ts`. The actions revalidate input, write to private DB-backed marketing/contact storage, then send Resend emails non-blockingly. Booking marketing choices are audited in the private DB from the booking service.

Good signs:

- Server-side validation duplicates client validation.
- Private DB write failure blocks success and prevents email sending.
- Email failure is non-blocking and logged.
- New form/contact/marketing records are not written to Sanity.
- Consent/no-consent choices are captured as private DB audit evidence.

Production-readiness gaps:

- End-to-end form verification requires private `DATABASE_URL`, `RESEND_API_KEY`, `FROM_EMAIL`, and `ADMIN_EMAIL` in the target environment.
- There is no explicit spam/rate-limit layer for public forms.
- `SANITY_FORM_TOKEN` should be removed from live form-write launch requirements unless explicitly retained for legacy/conditional Sanity submission work.
- Launch evidence must prove general inquiry, training contact, contact popup, opted-in booking marketing choice, and not-opted-in booking marketing choice records reach the private DB with PII redacted in evidence.
- Launch evidence must prove no new `generalInquiry`, `contactForm`, `contactPopupSubmission`, or `bookingMarketingOptIn` Sanity documents are created by live flows.

### Private Database And Migrations

Shared private PII storage uses Drizzle and Postgres. Runtime code gets a pooled `DATABASE_URL`, uses SSL with `rejectUnauthorized: true`, and models:

- `checkout_orders`
- `checkout_payment_events`
- `training_enrollments`
- `marketing_contacts`
- `marketing_contact_submissions`
- `marketing_consent_events`

The repo includes Drizzle migrations and scripts:

- `npm run db:generate`
- `npm run db:migrate`
- `scripts/migrate-private-db.ts`

Good signs:

- Sensitive checkout, marketing/contact, and consent records are outside Sanity.
- Checkout token hashes and scheduling token hashes are unique.
- Payment event idempotency keys are unique.
- Training enrollments cascade from checkout orders.
- Setup docs require separate staging and production databases and backups/PITR where available.
- Sanity submission backfill records preserve source system/document provenance in private DB tables.

Production-readiness gaps:

- There is no proof in repo that staging migrations have been applied to the target database.
- There is no proof in repo that production database backups/PITR are enabled.
- There is no retention/redaction job. Docs state the business owner/counsel must choose retention decisions by record type, but implementation does not yet enforce redaction.
- `DATABASE_URL` validation only checks presence, not whether the URL points to staging vs production.
- Backfill dry-run/execute evidence and Sanity source retention/redaction decisions must be recorded before importing historical submission docs.

Recommendation:

- Before launch, run migrations against staging, complete checkout and marketing/contact smoke tests, then run migrations against production in a controlled release window.
- Add an operator checklist that records database host/branch, migration version, backup status, and rollback plan.
- Do not add order/contact dashboards until access control, audit logging, and retention policy are defined.

### Logging, Monitoring, And Observability

The current system logs failures through `console.error`, `console.warn`, and `console.log` in route handlers, booking service, form actions, revalidation, block rendering, and webhook handling.

Good signs:

- Payment and webhook code logs meaningful contexts such as order ID or event ID without intentionally logging full secrets.
- User-facing responses are generic and do not expose sensitive details.

Not production-ready:

- There is no structured logger.
- There are no request IDs/correlation IDs.
- There is no alerting for webhook failures, payment verification failures, booking failures, revalidation failures, or email failures.
- There is no long-retention log drain configured in code/docs.
- There is no dashboard or runbook for checking production payment/order health.

Recommendation:

- At minimum for launch, configure Vercel log access and define an incident checklist for failed checkout, failed webhook, failed booking, and failed revalidation.
- Prefer adding a structured logging layer or log drain before accepting real production payments at scale.
- Add explicit payment and booking health checks that can be run manually after deploy.

### Testing

Current scripts:

- `npm run lint`
- `npm run build`
- `npm test`
- `npm run test:unit`
- `npm run test:ui`

Good coverage exists for:

- cart validation,
- money helpers,
- Helcim hash and webhook parsing,
- payment verification,
- order storage,
- training enrollment and notification state,
- booking availability,
- Google Calendar payload handling,
- paid training booking context,
- route-level Helcim webhook handler tests.

Current critical API coverage inventory:

| API boundary | Current automated route coverage | Remaining launch evidence |
| --- | --- | --- |
| `/api/revalidate` | Valid signature/tag revalidation, invalid signature, null signature, missing `_type`, and unknown `_type` no-op. | Live staging Sanity publish/webhook smoke has not been run. |
| `/api/checkout` | Invalid request rejection, valid cart checkout initialization, Helcim initialization failure, and pending order persistence failure. | Live staging product checkout, private DB transition, and Helcim evidence have not been run. |
| `/api/training-checkout` | Success/failure paths including enrollment write failure are covered by route-handler tests. | Live staging training checkout, enrollment, order-based confirmation, and booking handoff smoke has not been run. |
| `/api/checkout/validate-payment` | Success and critical failure paths, including invalid hash, missing order, and persistence failure, are covered by route-handler tests. | Live staging payment validation against Helcim-returned data has not been run. |
| `/api/webhooks/card-transactions` | Route-level Helcim webhook handler tests cover signature/parsing and payment event behavior. | Live staging Helcim webhook delivery and idempotency evidence has not been run. |
| `/api/booking/*` | Booking availability and create route handlers now have direct mocked/local route-handler coverage, alongside booking service unit coverage. | Live staging Redis/Upstash, Google OAuth, availability markers, and Calendar event smoke have not been run. |

Production confidence gaps:

- Direct route-handler tests now cover the highest-risk checkout, training checkout, payment validation, webhook, revalidation, and booking availability/create paths with mocked/local dependencies.
- Playwright tests use browser/API mocks for checkout and booking. These verify UI behavior but not live external integration.
- `tests/utils/api-mocks.ts` now explicitly documents its legacy endpoint fixtures as mocked UX fixtures; they are useful for browser-flow coverage but are not proof of the live Sanity server-side data flow.
- Some historical docs and comments still refer to older frontend paths or Strapi migration phases.

Recommendation:

- Keep route-handler tests for critical API boundaries current as checkout, payment, booking, and revalidation behavior changes.
- Keep Playwright mocked UX tests, but add a separate manual/live smoke checklist for staging integrations.
- Do not claim production readiness based only on mocked E2E tests.

## Critical Launch Blockers

These should be completed before production promotion.

1. Verify all production environment variables in Vercel.
   - Sanity: `NEXT_PUBLIC_SANITY_PROJECT_ID`, `NEXT_PUBLIC_SANITY_DATASET=production`, `NEXT_PUBLIC_SANITY_API_VERSION`, `SANITY_WRITE_TOKEN`, `SANITY_WEBHOOK_SECRET`. `SANITY_FORM_TOKEN` is legacy/conditional only if retained for documented Sanity submission backfill work.
   - Email: `RESEND_API_KEY`, `FROM_EMAIL`, `ADMIN_EMAIL`.
   - Booking: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `BOOKING_ADMIN_SETUP_SECRET`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`.
   - Checkout: `DATABASE_URL`, `CHECKOUT_SECRET_ENCRYPTION_KEY`, `HELCIM_GENERAL_API_TOKEN`, `HELCIM_TRANSACTION_API_TOKEN`, `HELCIM_WEBHOOK_VERIFIER_TOKEN`.

2. Apply and verify private database migrations.
   - Confirm target database is production, not staging.
   - Confirm backups/PITR.
   - Run `npm run db:migrate` only after approval.
   - Verify tables and migration state.

3. Run live staging smoke tests before production.
   - Product checkout creates a pending private order.
   - Helcim success marks order paid.
   - Helcim webhook arrives, verifies, and records idempotently.
   - Training checkout creates pending order and enrollment.
   - Training payment sends an order-based scheduling link.
   - Scheduling link resolves into booking flow and requires checkout-email verification before slots load.
   - Booking creates a Google Calendar event and marks enrollment scheduled.
   - General inquiry, training contact, contact popup, and booking marketing choices write private DB evidence.
   - Booking marketing smoke covers both opted-in and not-opted-in choices.
   - Live flows create no new Sanity submission documents.

4. Configure and test Sanity production webhook.
   - Endpoint: `https://<production-domain>/api/revalidate`.
   - Projection: `{ _type }`.
   - Secret: exact `SANITY_WEBHOOK_SECRET`.
   - Publish a production content change and confirm page update.

5. Configure and test Google Calendar production OAuth.
   - Run `/api/booking/oauth/start?secret=<BOOKING_ADMIN_SETUP_SECRET>`.
   - Confirm refresh token stored in production Upstash.
   - Confirm production `bookingSettings.calendarId` matches the connected calendar.
   - Confirm availability markers produce bookable slots.

6. Configure and test Resend.
   - Verify sending domain and `FROM_EMAIL`.
   - Submit general inquiry, training contact, contact popup, booking, and training purchase flows.
   - Confirm admin and customer emails where expected.
   - Confirm private DB writes occur before email evidence is accepted for forms.

7. Resolve launch-facing data/copy gaps.
   - Replace placeholder JSON-LD phone/email/address/logo/hours in `src/app/(site)/layout.tsx`.
   - Verify implemented general product order confirmation email behavior or remove/change the promise on `/products/confirmation` before launch.
   - Remove or update legacy Strapi values in `.env.local.example`.

8. Maintain minimum critical route-handler tests.
   - `/api/checkout` success/failure, including Helcim initialization and pending order persistence failures.
   - `/api/training-checkout` success/failure and enrollment write failure.
   - `/api/checkout/validate-payment` success, invalid hash, missing order, persistence failure.
   - `/api/revalidate` valid signature, invalid/null signature, missing type, and unknown type.

## High-Priority Recommendations

### 1. Add Checkout Reconciliation And Cleanup

Current risk: Helcim invoice/session creation and private DB writes are not atomic. External Helcim state can exist without a local order, and a training order can exist without enrollment.

Options:

- Minimal launch option: add explicit logging and a manual reconciliation runbook for orphan Helcim invoices/sessions and pending orders older than a threshold.
- Better option: persist an initial local checkout attempt before Helcim calls, then update it with Helcim invoice/session data.
- Best option: introduce a durable workflow or queue-based reconciliation process that can retry each stage safely.

Recommended for launch: minimal runbook plus route tests. Recommended after launch: pre-persist checkout attempts or durable workflow.

### 2. Strengthen Observability

Current risk: real failures will be visible only if someone manually reads Vercel logs.

Minimum launch additions:

- Define where Vercel runtime logs are reviewed.
- Add a launch-day watch checklist for checkout, webhook, booking, revalidation, and email logs.
- Document what status codes indicate retryable failures.

Better additions:

- Structured logging with event names and correlation IDs.
- Vercel log drain or external logging provider.
- Alerts for repeated webhook 5xx, checkout validation 5xx, booking create failures, and revalidation 401/5xx spikes.

### 3. Replace Stale Docs And Env Examples

Current risk: operators may configure old Strapi/Blob/Motion variables or miss newer checkout/booking variables.

Actions:

- Rewrite `.env.local.example` around the current launch stack.
- Replace README boilerplate with project-specific setup, launch, and smoke-test guidance.
- Keep historical Strapi migration docs in `.planning` but mark them as historical.

### 4. Add Editorial Guardrails

Current risk: editors can attach a non-training product to a training program until runtime rejects checkout.

Actions:

- Add Sanity validation or a custom input guard for `trainingProgram.checkoutProduct` kind.
- Add a pre-launch GROQ audit query for training programs with `checkoutEnabled == true` and invalid/missing checkout products.

### 5. Decide Payment Provider Strategy

Helcim is implemented with sensible guardrails. It can launch if the business specifically requires it and staging smoke tests pass. However, the implementation is custom enough that launch operations require discipline.

Alternative: Stripe Checkout would reduce long-term operational complexity for hosted checkout, fulfillment webhooks, local testing, ecosystem documentation, and future refunds/taxes/discounts/subscriptions. This is a strategic alternative, not a mandatory blocker.

## Suggested Launch Checklist

### Code Checks

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm run test:unit`
- [ ] `npm test` or at least key Chromium specs for homepage, contact, training, products, checkout, booking
- [ ] No `test.only`
- [ ] No unexpected `TODO` in launch-facing code except explicitly approved backlog

### Live Staging Smoke Matrix

These checks require explicit live staging approval, real staging credentials, and recorded evidence before production promotion. They are separate from mocked Playwright UX tests; mocked tests do not prove live Sanity, Helcim, database, Redis/Upstash, Google Calendar, or Resend integration health.

| Area | Live staging check | Required evidence | Status |
| --- | --- | --- | --- |
| Product checkout | Complete a product cart checkout through the staging Helcim flow. | Checkout session/invoice reference, approved test transaction, and public confirmation page screenshot or log reference. | Not run |
| Training checkout | Complete a training checkout through the staging Helcim flow. | Training checkout session/invoice reference, approved test transaction, confirmation page evidence, and order-based scheduling link evidence. | Not run |
| Helcim webhook | Confirm `/api/webhooks/card-transactions` receives and verifies the staging card transaction event. | Vercel log/event ID showing accepted signature, transaction lookup, idempotency key, and non-secret Helcim reference. | Not run |
| Private DB state | Verify pending checkout rows transition to paid, payment events are stored idempotently, and form/marketing submissions produce consent/no-consent records. | Redacted database query output for checkout/order, training enrollment when applicable, payment event, marketing contact submission, and consent event rows. | Not run |
| Paid training eligibility | Confirm paid training checkout sends an order-based booking link and rejects mismatched checkout emails. | Redacted order/enrollment record or log, valid booking link behavior, and negative-case result. | Not run |
| Booking Calendar event | Book a paid training call and a standard booking path against the staging calendar. | Google Calendar event IDs/timestamps, booking type, timezone, and attendee email redacted as needed. | Not run |
| Sanity revalidation | Publish a staging Sanity edit and confirm the signed webhook refreshes the staging page only. | Sanity publish timestamp, webhook delivery result, cache tag/log reference, and before/after page evidence. | Not run |
| Redis/Upstash | Verify OAuth refresh token access, booking locks, and idempotency keys in staging. | Redacted Upstash key presence/TTL or logs proving read/write/expiry behavior. | Not run |
| Resend emails | Trigger general inquiry, training contact, contact popup, booking confirmation, and training payment email paths after private DB writes. | Resend message IDs/statuses and recipient/domain evidence with addresses redacted as needed. | Not run |

### Sanity Checks

- [ ] Production dataset is `production`
- [ ] Preview/staging dataset is `staging-2026-05-10`
- [ ] Production schema deployed
- [ ] Embedded `/studio` opens and targets the intended dataset
- [ ] Production webhook configured and verified
- [ ] No checkout records exist in Sanity
- [ ] No new `generalInquiry`, `contactForm`, `contactPopupSubmission`, or `bookingMarketingOptIn` documents are created by live flows
- [ ] Any existing submission document types are documented as legacy/backfill-only or pending removal/hiding after retention decision
- [ ] Training programs with checkout enabled have valid training products

### Database Checks

- [ ] Production `DATABASE_URL` points to intended database
- [ ] Migrations applied
- [ ] Backups/PITR verified
- [ ] Test order can be created and marked paid
- [ ] Pending/failed orders can be queried by operator if support is needed
- [ ] General inquiry, training contact, contact popup, and booking marketing choices write to private DB tables
- [ ] Consent event evidence covers opt-in and no-opt-in choices with PII redacted in evidence
- [ ] Backfill dry-run/execute evidence template, provenance fields, duplicate protection, and stop conditions are ready before any backfill command is approved

### Payment Checks

- [ ] Helcim general API token works
- [ ] Helcim transaction API token works
- [ ] `CHECKOUT_SECRET_ENCRYPTION_KEY` is base64-encoded 32 bytes
- [ ] Product checkout succeeds in staging
- [ ] Training checkout succeeds in staging
- [ ] Webhook endpoint receives and verifies card transaction events
- [ ] Duplicate webhook delivery is idempotent

### Booking Checks

- [ ] Google Calendar API enabled
- [ ] OAuth consent configured
- [ ] Production OAuth callback URL matches `GOOGLE_REDIRECT_URI`
- [ ] OAuth setup stores refresh token in production Redis
- [ ] `bookingSettings` has correct calendar ID, timezone, lead time, horizon, buffers, and booking types
- [ ] Availability loads from marker events
- [ ] Booking creates Google Calendar event and sends confirmation email
- [ ] Paid training order/email booking path works

### Email Checks

- [ ] Resend domain verified
- [ ] `FROM_EMAIL` aligned with verified domain
- [ ] `ADMIN_EMAIL` correct
- [ ] General inquiry email path verified
- [ ] Training contact email path verified
- [ ] Contact popup email path verified after private DB submission persistence
- [ ] Booking confirmation email path verified
- [ ] Training payment email path verified
- [ ] Product order confirmation email behavior verified, or confirmation copy changed if verification fails

### Operations Checks

- [ ] Rollback plan documented
- [ ] Person responsible for launch monitoring assigned
- [ ] Vercel logs monitored during launch
- [ ] Helcim dashboard accessible during launch
- [ ] Sanity Manage accessible during launch
- [ ] Database provider dashboard accessible during launch
- [ ] Google Calendar owner/admin available during launch

## Remediation Backlog

### P0 - Before Production Launch

1. Complete live staging smoke test across Sanity, DB, Helcim, webhook, booking, Redis, Google Calendar, and Resend.
2. Apply database migrations to production only after staging passes and backups are verified.
3. Fix `.env.local.example` to remove legacy Strapi/Blob/Motion registry values and include all current launch env vars.
4. Replace placeholder JSON-LD business data.
5. Verify product order confirmation email behavior or update confirmation page copy if verification fails.
6. Verify private DB form/contact/consent writes and no new Sanity submission docs in staging.
7. Keep direct route-handler tests for checkout/payment/revalidation critical paths current, and add booking route-handler coverage where practical.
8. Add manual reconciliation runbook for pending/orphan checkout records and Helcim invoices.

### P1 - Soon After Launch

1. Add structured logging and alerting.
2. Add checkout attempt pre-persistence or durable reconciliation.
3. Add Sanity validation for training product kind.
4. Add spam/rate-limit controls for public forms and booking endpoints.
5. Add retention/redaction process for checkout, marketing/contact, consent, and suppression records after owner/counsel decisions.
6. Keep Playwright mock fixture comments aligned with the current Sanity-backed architecture as tests evolve.

### P2 - Strategic Improvements

1. Evaluate Stripe Checkout or another more common hosted checkout platform if Helcim operations prove costly.
2. Add internal order/support tooling only with access control and audit logging.
3. Add self-serve booking cancellation/rescheduling if business process requires it.
4. Expand analytics around checkout conversion and booking completion.

## Final Recommendation

The staging branch should not be promoted directly to production today as-is. The codebase has a credible production architecture and many of the right security boundaries, but launch depends on external systems that must be configured and tested live. The minimum safe path is:

1. Clean launch docs and env examples.
2. Keep critical route tests passing and current.
3. Run staging migrations and full integration smoke tests with real staging services.
4. Fix launch-facing copy/data placeholders.
5. Configure production services and run a controlled production smoke test.
6. Launch with active log monitoring and a rollback/reconciliation plan.

If those steps pass, the site can launch smoothly with the current architecture. Without them, the highest risks are failed payments that require manual reconciliation, booking handoff failures after training payment, stale content due to webhook misconfiguration, and lack of timely detection when production integrations fail.
