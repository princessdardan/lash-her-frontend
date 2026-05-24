# Booking and Helcim Implementation Summary

Date: 2026-05-08
Primary implementation worktree: `/Users/dardan/Documents/lash-her/.worktrees/booking-helcim-integration`
Integration branch: `integration/booking-helcim`

## Purpose

This document summarizes the booking and HelcimPay work that has been implemented so future agents can build on it without rediscovering the architecture. It is a handoff summary, not proof that the branch is production-ready.

> **2026-05-20 update:** This summary describes the historical implementation. Current commerce work is governed by `docs/superpowers/plans/2026-05-20-commerce-taxonomy-migration-hardening.md` and `docs/booking-system-architecture-reference.md`. Active checkout uses canonical `product`, `service`, `bookingOffering`, and native `trainingProgram` commerce fields.

The implementation combines two originally separate efforts:

- A scheduling-only Google Calendar booking system.
- A Sanity-backed shop and HelcimPay.js checkout flow.

**Note:** Later private storage remediation supersedes the original Sanity-based order and booking-marketing storage. Checkout orders, payment events, marketing contacts, contact submissions, and consent events belong in the private PostgreSQL database to protect customer PII and transaction/consent history.

Historically, the two features were intentionally separate. Booking did not take payments, and checkout did not create Google Calendar bookings. This is superseded for future work by the unified booking redesign linked above.

## Source Plans

- `docs/superpowers/specs/2026-05-05-booking-system-design.md`
- `docs/superpowers/plans/2026-05-05-helcimpay-implementation.md`
- Integration context in the worktree: `docs/superpowers/plans/2026-05-08-booking-helcimpay-integration.md`

## Implemented Booking System

The booking implementation adds a public scheduling flow at `/booking`, with optional preselection through query params such as `/booking?type=training-call` and `/booking?type=in-person-appointment`.

Implemented surfaces:

- `src/app/(site)/booking/page.tsx`
- `src/components/booking/booking-flow.tsx`
- `src/components/booking/booking-entry-link.tsx`
- `src/app/api/booking/availability/route.ts`
- `src/app/api/booking/create/route.ts`
- `src/app/api/booking/oauth/start/route.ts`
- `src/app/api/booking/oauth/callback/route.ts`
- `src/lib/booking/*`
- `src/sanity/schemas/documents/booking-settings.ts`
- `src/sanity/schemas/documents/booking-marketing-opt-in.ts`
- `tests/booking.spec.ts`

Core behavior:

- Sanity `bookingSettings` stores calendar ID, marker title, booking horizon, minimum lead time, timezone, booking types, durations, intervals, buffers, type-specific questions, and marketing opt-in copy.
- Google Calendar is the source of truth for availability and confirmed bookings.
- Availability is represented by Google Calendar events whose title matches the configured marker, defaulting to `Available for booking`.
- All non-marker events on the same calendar are treated as busy conflicts, including Fresha/manual/site-created events.
- Slot generation enforces minimum lead time, booking horizon, duration, interval, and before/after buffers.
- Booking creation revalidates the selected slot server-side before inserting a Google Calendar event.
- A whole-calendar lock and idempotency key are stored in Upstash Redis through `src/lib/booking/operational-store.ts`.
- Google OAuth setup is protected by `BOOKING_ADMIN_SETUP_SECRET` and stores the refresh token server-side in Redis.
- The Google Calendar event includes the customer as an attendee and uses `sendUpdates: "all"`.
- Resend confirmation email is sent after Calendar insertion. If the email fails, booking remains confirmed and the failure is logged.
- Booking marketing choices are now audited in private DB-backed submission/consent tables. Historical Sanity `bookingMarketingOptIn` documents, if present, are backfill sources only.

Important intentional non-goals from the booking design remain unimplemented:

- No booking payments.
- No Google Meet links.
- No self-serve cancellation or rescheduling.
- No approval workflow.
- No multiple staff calendars.
- No persisted booking history in Sanity.

## Implemented Helcim Checkout

The checkout implementation exposes the public product catalog at `/products`, product detail pages at `/products/[slug]`, and a confirmation page at `/products/confirmation`.

Implemented surfaces:

- `src/app/(site)/products/page.tsx`
- `src/app/(site)/products/[slug]/page.tsx`
- `src/app/(site)/products/confirmation/page.tsx`
- `src/components/commerce/product-card.tsx`
- `src/components/commerce/cart-panel.tsx`
- `src/components/commerce/helcim-pay-button.tsx`
- `src/app/api/checkout/route.ts`
- `src/app/api/checkout/validate-payment/route.ts`
- `src/lib/commerce/*`
- Active checkout uses `product`, `service`, `bookingOffering`, and native `trainingProgram` schema fields.
- `src/lib/private-db/*`
- `src/app/api/webhooks/card-transactions/route.ts` (Renamed from `/helcim` to satisfy Helcim dashboard URL restrictions)
- `tests/checkout.spec.ts`

Core behavior:

- The catalog source is canonical Sanity `product` documents. Services, booking offerings, and training programs own their own public commerce fields.
- Supported currency is CAD.
- Cart validation enforces whole-number quantities from 1 to 10.
- Server-side checkout reloads Sanity products by ID and rebuilds invoice line items from current catalog data.
- The checkout API creates a Helcim invoice first, initializes a HelcimPay.js session, then stores a pending private checkout reconciliation record in a server-side PostgreSQL database after remediation.
- Helcim API credentials stay server-side through `getHelcimApiToken()`.
- Browser receives only the HelcimPay.js `checkoutToken`.
- HelcimPay.js is loaded from `https://secure.helcim.app/helcim-pay/services/start.js`.
- The client listens for `helcim-pay-js-${checkoutToken}` messages from `https://secure.helcim.app`.
- Successful Helcim iframe payloads are forwarded to `/api/checkout/validate-payment`.
- Validation checks the response hash, approved status, transaction ID, amount, currency, and invoice identity.
- Pending order secret tokens are encrypted before being stored in the private database using `CHECKOUT_SECRET_ENCRYPTION_KEY`.
- Validated payments mark the private checkout record as `paid`; failed verification marks it as `verification_failed`.

Intentional first-release non-goals remain unimplemented:

- No taxes, discounts, shipping, ACH-specific flow, Fee Saver, partial payments, refunds, saved payment methods, or customer pre-linking.

## Shared Integration Surfaces

The integration branch merges booking and checkout additions into shared files:

- `package.json` adds `test:unit` and dependencies for `googleapis`, `@upstash/redis`, and `tsx`.
- `src/data/loaders.ts` includes `getBookingSettings`, canonical product catalog loaders, and native training/booking loaders.
- `src/sanity/env.ts` includes booking env helpers, Helcim token helper, and checkout secret encryption key helper.
- Active revalidation must include cache tags for `bookingSettings`, `bookingOffering`, `service`, `product`, and `trainingProgram` where those document types affect public pages.
- `src/sanity/schemas/index.ts` registers booking and catalog schemas.
- `src/sanity/structure/index.ts` should expose Booking, canonical Products, Services, and Training Programs in Studio. Checkout Orders belong in private storage and must not be exposed in Studio after remediation.
- `src/types/index.ts` exports booking types and commerce document types.

## Required Environment Variables

Booking:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `BOOKING_ADMIN_SETUP_SECRET`
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`
- `RESEND_API_KEY`
- `FROM_EMAIL`
- `DATABASE_URL` for private booking marketing choice audit records

Checkout:

- `DATABASE_URL`
- `HELCIM_GENERAL_API_TOKEN`
- `HELCIM_TRANSACTION_API_TOKEN`
- `CHECKOUT_SECRET_ENCRYPTION_KEY`
- `HELCIM_WEBHOOK_VERIFIER_TOKEN` if Helcim webhooks are enabled.

`CHECKOUT_SECRET_ENCRYPTION_KEY` must be a base64-encoded 32-byte key. `DATABASE_URL`, Helcim tokens, and encryption keys must remain server-only and must never use `NEXT_PUBLIC_*` names.

## Known Gaps and Follow-Up Risks

- The requested worktree was referred to as `booking-helcim-itegration`, but the actual path is `.worktrees/booking-helcim-integration`.
- Staging and production Neon connection strings still need to be configured in deployment environments before shared private PII storage can be smoke-tested against a real database.
- Historical audit note: the checkout confirmation page promised an order confirmation email before the checkout-specific sender was confirmed. Current launch docs require verifying the implemented product order confirmation email behavior with Resend evidence.
- Playwright tests mock booking and checkout API calls, but the pages still depend on Sanity server-rendered data. E2E coverage is therefore not fully self-contained without seeded Sanity content.
- There are helper unit tests and browser tests, but no direct route-handler unit tests for `/api/checkout`, `/api/checkout/validate-payment`, or `/api/booking/*`.
- The branch includes broader UI/style/docs/artifact changes beyond the booking and Helcim feature files. Review the diff carefully before merging.
- `git diff --check main...HEAD` reported trailing whitespace at `src/components/custom/layouts/cta-features-section.tsx:78` during audit.
- Local validation could not be completed before this summary because dependencies were not installed in the integration worktree; `npm run test:unit` failed with `tsx: command not found` and `npm run lint` failed with `eslint: command not found`.

## Verification Status From Audit

Completed during audit:

- Read the booking design and Helcim implementation plan.
- Located the integration worktree with `git worktree list`.
- Searched relevant implementation surfaces with `rg` and AST-aware search.
- Read key route, library, schema, UI, loader, and test files.
- Checked external docs for HelcimPay.js validation and Google Calendar event insertion expectations.

Not completed during audit:

- Unit tests.
- Lint.
- Build.
- Playwright E2E.

Before merging or building on this branch, install dependencies at the repository root and run:

```bash
npm run test:unit
npm run lint
npm run build
npx playwright test tests/booking.spec.ts --project=chromium
npx playwright test tests/checkout.spec.ts --project=chromium
```

## Agent Guidance

When extending booking:

- Keep Google Calendar as the only confirmed booking record.
- Do not add Sanity booking-history persistence unless the product decision changes.
- Revalidate selected slots server-side immediately before inserting a Calendar event.
- Preserve the whole-calendar Redis lock unless replacing it with a stronger concurrency strategy.

When extending checkout:

- Never expose Helcim API credentials or `secretToken` to the browser.
- Build line-item snapshots from validated Sanity catalog data, not client-supplied prices.
- Keep `checkoutOrder` as a private database reconciliation record, not a full ecommerce order-management system.
- Do not store transaction history or customer PII in public Sanity datasets.
- Validate Helcim hash and payment semantics before marking an order paid.

When merging:

- Protect current main-workspace WIP before applying the integration branch.
- Review shared files additively: `loaders.ts`, `env.ts`, schema registry, Studio structure, revalidation tags, and shared types.
- Do not claim validation passed unless the command was run and exited 0.
