# Booking System Setup Guide

Date: 2026-05-19

This guide sets up the Lash Her unified booking system for a staging or production environment. It covers Sanity booking content, private storage, Upstash Redis, Google Calendar OAuth, Helcim, Resend, and smoke tests.

Run commands from the repository root: `/Users/dardan/workspace/lash-her-frontend`.

Do not run private database migrations until the target database, approval, backup/PITR, and staging evidence requirements in `docs/private-database-migration-runbook.md` are satisfied.

## Setup Order

1. Confirm repository and environment target.
2. Configure server-only environment variables.
3. Provision private Postgres.
4. Provision Upstash Redis.
5. Configure Google OAuth and connect the calendar.
6. Configure Sanity booking settings and offerings.
7. Configure Helcim API credentials and webhook.
8. Configure Resend.
9. Run staging smoke tests.
10. Prepare production handoff evidence.

## 1. Confirm The Target

Before adding secrets or running setup flows, record:

| Field | Staging | Production |
| --- | --- | --- |
| App URL | `https://<staging-domain>` | `https://<production-domain>` |
| Sanity dataset | `staging-2026-05-10` | `production` |
| Private DB provider/project | | |
| Upstash Redis database | | |
| Google OAuth client | | |
| Helcim mode/account | | |
| Resend sender domain | | |

Use separate staging and production credentials wherever the provider supports it.

## 2. Commands And Local Prereqs

Install dependencies and run checks from the repo root:

```bash
npm install
npm run dev
npm run lint
npm run build
npm test
npm run test:unit
node scripts/validate-sanity-env.mjs
```

For local development, copy `.env.local.example` to `.env.local` and replace placeholders. If the development server uses a non-default port, make the local app origin and OAuth redirect URI use the same port.

Generate database migrations only after intentional schema changes:

```bash
npm run db:generate
```

The migration apply command is gated. Run `npm run db:migrate` only after following `docs/private-database-migration-runbook.md`, verifying `DATABASE_URL`, and receiving explicit approval for the target environment.

## 3. Environment Variables

Add these to the matching Vercel environment and local server-only configuration where needed.

### Sanity

```env
NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84
NEXT_PUBLIC_SANITY_DATASET=<staging-2026-05-10-or-production>
NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24
SANITY_WRITE_TOKEN=<server-only-write-token>
SANITY_FORM_TOKEN=<server-only-form-token>
SANITY_WEBHOOK_SECRET=<signed-webhook-secret>
```

Only `NEXT_PUBLIC_*` values are browser-visible. Keep write/form/webhook tokens server-only.

### Email

```env
RESEND_API_KEY=<resend-api-key>
FROM_EMAIL=<verified-sender-address>
ADMIN_EMAIL=<admin-recipient-address>
```

### Google Calendar Booking

```env
GOOGLE_CLIENT_ID=<oauth-client-id>
GOOGLE_CLIENT_SECRET=<oauth-client-secret>
GOOGLE_REDIRECT_URI=https://<domain>/api/booking/oauth/callback
BOOKING_ADMIN_SETUP_SECRET=<long-random-setup-secret>
```

Use the target environment domain in `GOOGLE_REDIRECT_URI`. The value must exactly match the Google OAuth authorized redirect URI.

### Upstash Redis

```env
KV_REST_API_URL=<upstash-redis-rest-url>
KV_REST_API_TOKEN=<upstash-redis-rest-token>
```

The same Redis instance used during OAuth setup must be available to booking runtime routes.

### Private Postgres And Helcim

```env
DATABASE_URL=<server-only-pooled-postgres-url>
CHECKOUT_SECRET_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
HELCIM_GENERAL_API_TOKEN=<helcim-general-api-token>
HELCIM_TRANSACTION_API_TOKEN=<helcim-transaction-api-token>
HELCIM_WEBHOOK_VERIFIER_TOKEN=<helcim-webhook-verifier-token>
```

Never prefix private values with `NEXT_PUBLIC_`. Do not paste real connection strings, tokens, customer data, or payment identifiers into docs, tickets, or chat.

## 4. Private Postgres Setup

The private database stores checkout orders, payment events, appointment holds, training enrollments, marketing contacts, contact submissions, consent events, and operational reconciliation state.

1. Create separate staging and production databases, branches, or projects.
2. Prefer a pooled server-side connection string for runtime `DATABASE_URL`.
3. Enable automated backups and PITR for production if the provider supports it.
4. Add staging `DATABASE_URL` only to staging/local staging contexts.
5. Add production `DATABASE_URL` only to production contexts.
6. Confirm the provider, project, branch, and host label without exposing the secret.
7. Apply generated migrations only through `docs/private-database-migration-runbook.md`.

Migration hard rules:

- Verify `DATABASE_URL` before any migration command.
- Run staging first and smoke test before production.
- Do not use schema push in production.
- Do not manually edit production schema to fix a failed migration.
- Do not run migration scripts just to inspect behavior.

## 5. Upstash Redis Setup

Redis is used for:

- Google Calendar OAuth refresh-token storage.
- Calendar write locks.
- Booking idempotency keys.
- Short-lived scoped locks.

Setup steps:

1. Create a Redis database for staging and one for production, or otherwise isolate environments.
2. Copy the REST URL and REST token into `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. Redeploy or restart the target app after adding variables.
4. Connect Google Calendar OAuth after Redis variables are present; the refresh token is stored there.
5. During smoke, confirm booking routes can read/write lock keys and that TTL behavior works.

Redis is not canonical booking or payment storage. If Redis data is lost, reconnect OAuth and verify private DB state before accepting paid bookings.

## 6. Google Cloud OAuth And Calendar

Configure one Google Cloud project or one environment-specific project with:

- Google Calendar API enabled.
- OAuth consent screen.
- OAuth 2.0 Client ID of type `Web application`.
- Authorized redirect URI for each environment.

Required Calendar scope:

```text
https://www.googleapis.com/auth/calendar.events
```

Redirect URI format:

```text
https://<domain>/api/booking/oauth/callback
```

Setup steps:

1. In Google Cloud Console, enable Google Calendar API.
2. Configure the OAuth consent screen and add the calendar owner as a test user if the app remains in testing.
3. Create a Web Application OAuth client for the environment.
4. Add the exact redirect URI for that environment.
5. Add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` to Vercel.
6. Confirm `BOOKING_ADMIN_SETUP_SECRET` and Upstash Redis vars are present.
7. Visit the protected setup URL in the target environment:

```text
https://<domain>/api/booking/oauth/start?secret=<BOOKING_ADMIN_SETUP_SECRET>
```

Expected result:

1. The route validates the setup secret.
2. Google asks the calendar owner to approve Calendar Events access.
3. Google redirects back to the app callback route.
4. The app stores the refresh token in Upstash Redis.
5. The browser shows that Google Calendar booking OAuth is connected.

Treat the setup URL as sensitive. Rotate `BOOKING_ADMIN_SETUP_SECRET` if the URL may have been logged or shared.

## 7. Sanity Booking Configuration

Sanity stores public booking configuration only. It must not store customer PII, holds, payment state, booking history, transaction records, or training eligibility state.

### Booking Settings Singleton

In Studio, configure the `bookingSettings` singleton:

| Field | Setup guidance |
| --- | --- |
| Google Calendar ID | Use `primary` or the exact connected calendar ID. |
| Availability Marker Title | Must match the title used for availability marker events in Google Calendar. |
| Booking Horizon Days | Choose how far out customers can book. |
| Minimum Lead Time Hours | Choose the minimum notice before a slot can be booked. |
| Booking Timezone | Use `America/Toronto` unless the business operating timezone changes. |
| Booking Types | Configure exactly `training-call` and `in-person-appointment`. |
| Marketing Opt-in Label | Confirm approved customer-facing consent copy. |

Add availability marker events to the connected Google Calendar using the configured marker title. Busy events and active private holds will block overlapping slots.

### Booking Offerings

Create active `bookingOffering` records for customer-selectable services.

Required fields:

- Title, description, slug, active status.
- Booking type: `training-call` or `in-person-appointment`.
- Duration, slot interval, buffer before, buffer after.
- Optional minimum lead-time override.
- Payment mode: deposit, full payment, or customer choice.
- Native CAD payment amounts as required by the selected payment mode.
- Display order.

Native payment field rules:

- Deposit mode requires a deposit amount.
- Full mode requires a full payment amount.
- Customer-choice/custom-partial mode requires a full payment amount plus custom minimum and maximum amounts.
- Legacy deposit/full product references are migration-only and must not be used for active booking checkout setup.

After publishing `bookingSettings` or `bookingOffering`, verify the Sanity webhook refreshes `/booking` in the target environment.

## 8. Helcim Setup

Helcim is used for paid appointment and product/training checkout.

1. Confirm API access is enabled in the Helcim account.
2. Add the general API token to `HELCIM_GENERAL_API_TOKEN`.
3. Add the transaction-processing token to `HELCIM_TRANSACTION_API_TOKEN`.
4. Generate a base64 32-byte `CHECKOUT_SECRET_ENCRYPTION_KEY` for encrypted secret-token storage.
5. Configure the card-transaction webhook URL:

```text
https://<domain>/api/webhooks/card-transactions
```

6. Add the webhook verifier token to `HELCIM_WEBHOOK_VERIFIER_TOKEN`.
7. Redeploy after changing tokens.

Operational expectations:

- The browser receives only the Helcim checkout token.
- The Helcim secret token stays server-side and is encrypted before storage.
- Webhook event IDs or idempotency keys are stored before state changes.
- Browser validation and webhook delivery may both finalize the same payment; finalization must remain idempotent.

## 9. Resend Setup

1. Verify the sender domain in Resend.
2. Add `RESEND_API_KEY`, `FROM_EMAIL`, and `ADMIN_EMAIL` to the target environment.
3. Redeploy after changing email variables.
4. Trigger staging emails for booking confirmation, paid training notification, product confirmation, contact, training contact, and contact popup flows.
5. Record Resend message IDs/statuses with addresses redacted.

Email failures should be logged for follow-up. They should not roll back a booking, payment, or private DB write that already succeeded.

## 10. Staging Smoke

Complete staging smoke before production handoff.

### Environment

- [ ] `VERCEL_ENV=preview node scripts/validate-sanity-env.mjs` passes for staging variables.
- [ ] Sanity dataset is `staging-2026-05-10`.
- [ ] Private DB identity is verified in the provider dashboard.
- [ ] Upstash Redis target is verified.
- [ ] Google OAuth setup succeeds and stores the refresh token.
- [ ] Helcim webhook delivery URL targets staging.
- [ ] Resend sender domain is verified.

### Public Booking

- [ ] `/booking` loads in staging.
- [ ] Active offerings appear from Sanity.
- [ ] Availability loads from Google Calendar.
- [ ] A standard booking creates one Calendar event.
- [ ] Booking confirmation email is sent or failure is logged.
- [ ] Marketing opt-in and no-opt-in booking paths write private audit evidence only.

### Paid Appointment

- [ ] A hold is created for the selected paid appointment slot.
- [ ] Helcim checkout initializes for the hold.
- [ ] Test payment marks the private order paid.
- [ ] The hold is booked or moved to manual follow-up.
- [ ] The Calendar event exists exactly once.
- [ ] Webhook retry or browser validation duplication does not create duplicate bookings.

### Paid Training

- [ ] Training checkout creates a paid private enrollment/order.
- [ ] Customer email copy points to `/booking?type=training-call&order=<order-reference>`.
- [ ] Wrong checkout email is rejected.
- [ ] Correct checkout email loads training-call slots.
- [ ] Training intro-call booking creates one Calendar event.
- [ ] Enrollment is marked scheduled/booked.

### Sanity And Privacy

- [ ] Publishing `bookingSettings` refreshes `/booking`.
- [ ] Publishing `bookingOffering` refreshes `/booking`.
- [ ] No new checkout, booking, form, marketing, consent, payment, or training private records are written to Sanity.
- [ ] Evidence is redacted and excludes secrets, PII, payment tokens, raw webhook bodies, and full connection strings.

## 11. Production Handoff

Production setup can proceed only after staging smoke passes.

Record:

| Evidence | Status |
| --- | --- |
| Staging smoke completed | |
| Production Sanity dataset verified | |
| Production private DB identity verified | |
| Production backup/PITR verified | |
| Production migration approval recorded if needed | |
| Production Upstash Redis verified | |
| Production Google OAuth connected | |
| Production Helcim webhook configured | |
| Production Resend sender verified | |
| Business/privacy owner confirmed | |
| Post-contract operator/vendor recorded | |

Production stop conditions:

- Target database identity cannot be verified.
- Backup/PITR is missing before an approved migration window.
- Required payment, calendar, Redis, or email secrets are absent.
- Sanity is storing new private operational records.
- Paid booking finalization cannot create Calendar events.
- Helcim webhook signatures cannot be verified.
- No operator is named for private-record follow-up.

## Related Documents

- `docs/booking-system-runbook.md`
- `docs/booking-system-architecture-reference.md`
- `docs/google-calendar-oauth-env-setup.md`
- `docs/private-checkout-storage-setup.md`
- `docs/private-database-migration-runbook.md`
- `docs/launch-readiness-checklist.md`
