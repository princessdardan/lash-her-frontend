# Booking System Setup Guide

Last verified: 2026-08-31

This is the setup index for the current PostgreSQL-backed booking system. Public service catalog data, booking settings, offerings, schedules, resources, Calendar assignments, holds, appointments, and payment state are operational records in private PostgreSQL. Sanity is optional editorial content for public service detail pages and remains the content source for training programs; it is not the service-booking control plane.

The public entry points are:

- `/services` for the operational service catalog.
- `/services/[slug]/booking` for selecting an offering and time.
- `/services/[slug]/booking/payment?session=...` for the opaque payment handoff.
- `/booking`, which is a permanent compatibility redirect to the canonical service routes. It is not a catalog page.

## Setup sequence

Use this order for a new local, preview, staging, or production environment:

1. Configure environment-scoped secrets and provider credentials.
2. Verify and migrate the private PostgreSQL database.
3. Configure Auth.js and create the authorized admin identities.
4. Create team/provider resources and Square team attribution.
5. Save business booking settings, provider offerings, prices, schedules, and exceptions in the admin dashboard.
6. Connect and assign Google Calendars for each provider primary resource.
7. Configure Square direct charge-and-store and the shared webhook.
8. Configure optional Sanity editorial service links and training scheduling.
9. Resolve every blocker on `/admin/setup`, then run the staging smoke tests before enabling production flags.

Do not activate a service merely because its public copy is complete. The operational readiness checks also require an active provider resource, an active offering, a weekly schedule, an active booking Calendar destination, and valid Square team attribution where required.

## 1. Environment configuration

Start with `.env.local.example`; it is the maintained inventory and includes comments about secret scope. Use different credentials and encryption keys for local, preview, and production.

The booking stack depends on these groups:

| Area                                 | Variables or configuration                                                                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private state                        | `DATABASE_URL`, `SERVICE_BOOKING_MODEL_MODE=operational`                                                                                                                                                       |
| Admin identity                       | `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, bootstrap `ADMIN_OWNER_EMAILS`                                                                                                                          |
| Calendar OAuth                       | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY`; compatibility `BOOKING_ADMIN_SETUP_SECRET` is still asserted by the shared booking env loader |
| Short-lived coordination             | `KV_REST_API_URL`, `KV_REST_API_TOKEN`                                                                                                                                                                         |
| Service payment                      | `SERVICE_BOOKING_SQUARE_ENABLED`, `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED`, and the Square variables documented in `docs/square-service-booking-setup.md`                                                 |
| Commerce payment                     | `SQUARE_COMMERCE_ENABLED` and `CHECKOUT_SECRET_ENCRYPTION_KEY` for product and primary training checkout                                                                                                       |
| Reconciliation/admin payment actions | `PAYMENT_RECONCILIATION_CRON_SECRET`, `CRON_SECRET`, `BOOKING_ADMIN_PAYMENT_ACTION_SECRET`                                                                                                                     |
| Transactional email                  | `RESEND_API_KEY`, `FROM_EMAIL`, `ADMIN_EMAIL`, and the required Resend webhook/segment values                                                                                                                  |
| Public/editorial content             | the target-specific Sanity project, dataset, read/write, and webhook variables                                                                                                                                 |

`AUTH_GOOGLE_*` authenticates staff to the admin app and requests identity scopes only. `GOOGLE_*` authorizes Calendar access. Use separate OAuth clients for those responsibilities and separate clients per deployed environment.

`BOOKING_ADMIN_SETUP_SECRET` protects the legacy global Calendar connection route; it is not the authority for current per-resource credentials. The shared `getBookingEnv()` accessor still asserts it when constructing the Google OAuth client, so keep a high-entropy server-only value configured until that compatibility dependency is removed. Do not distribute or use its query-string setup URL for a new environment.

Upstash stores short-lived OAuth state, booking contention locks, rate-limit windows, and active-hold quotas. It is not the authority for appointments, payment state, admin identity, or current Calendar credentials.

## 2. Private database

Run migration commands from the repository root. Verify the intended database without printing or pasting its URL:

```bash
npm run db:check -- --env-file <protected-env-file>
```

Do not run a bare `npm run db:migrate`. Follow the exact guarded invocation in `docs/private-database-migration-runbook.md`: `PRIVATE_DB_MIGRATION_TARGET` and `PRIVATE_DB_MIGRATION_HOST` must match the verified target, `DOTENV_CONFIG_PATH` must explicitly select a non-default protected env file, and production also requires `PRIVATE_DB_MIGRATION_CONFIRM=production`. Rerun the read-only `db:check` command after the guarded migration.

The migration runbook also covers staging, production, backups, and roll-forward recovery. The complete migration journal is authoritative; do not select migrations from an old booking milestone list.

## 3. Admin identity and operational records

Configure the Auth.js Google identity client, sign in through `/admin/sign-in`, and use `ADMIN_OWNER_EMAILS` only to bootstrap or recover owner access. Ongoing roles, account status, and resource access are PostgreSQL records.

Configure the system through these protected pages:

| Page                          | Current responsibility                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `/admin/staff`                | Team accounts, provider resources, active status, and Square sales matching                        |
| `/admin/booking-settings`     | Business timezone, booking window/notice, timing defaults, intake questions, and marketing wording |
| `/admin/offerings`            | Public services, provider-specific prices/durations/buffers, status, and add-ons                   |
| `/admin/schedules`            | Weekly hours, time off, extra hours, and links to Calendar sync                                    |
| `/admin/calendar-connections` | Owner/admin-managed Google accounts and per-resource Calendar assignments                          |
| `/admin/my-calendar`          | Employee-managed Google accounts for assigned provider resources                                   |
| `/admin/integrations`         | Google navigation plus Square team-attribution readiness and enforcement                           |
| `/admin/setup`                | Computed booking readiness and links to unresolved configuration                                   |

The public `/services` and `/services/[slug]/booking` routes read operational offerings and UI settings from PostgreSQL. Do not configure current service availability through the retired Sanity `bookingSettings` singleton or legacy booking fields on Sanity service documents.

An operational service may optionally link to a Sanity service document for richer editorial content and SEO. That link does not move prices, schedules, booking settings, or private state into Sanity.

## 4. Calendar connections

Set up Calendar only after the corresponding provider resource exists:

1. Configure the Calendar OAuth client and the dedicated credential-encryption key.
2. From `/admin/calendar-connections`, select **Connect Google account** for an owner-managed connection. An employee uses `/admin/my-calendar` for a resource assigned to that employee.
3. Complete Google consent. The shared callback is `/api/booking/oauth/callback`.
4. Let the dashboard discover calendars from the authorized account.
5. Assign a canonical Google Calendar ID to the provider's primary resource. Do not enter the alias `primary`.
6. Choose exactly one active booking destination for that primary resource. A destination both receives appointments and contributes busy time. Primary or secondary resources may also have busy-only assignments; a secondary room/equipment resource does not require a destination.
7. Return to `/admin/setup` and resolve any Calendar readiness blocker before activating offerings.

Refresh tokens are encrypted with `BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY` and stored with the connection in private PostgreSQL. See `docs/google-calendar-oauth-env-setup.md` and `docs/booking-training-calendar-configuration-guide.md` for the full provider setup and service/training boundaries.

## 5. Square and payment reconciliation

The current service flow is direct Square charge-and-store:

1. The booking flow collects bounded intake answers; `/api/booking/holds` reserves every required resource, persists the permitted intake data, and returns an opaque payment-session URL. It rejects contact and payment fields at this step.
2. The payment page collects the customer, payment selection, marketing choice, policy evidence, and Square card data. It does not accept client-selected routing fields.
3. Square tokenization uses `CHARGE_AND_STORE`.
4. `POST /api/booking/payment/confirm` captures the selected amount, saves the card for permitted no-show enforcement, persists provider evidence, creates the authoritative appointment, and projects it to the assigned Google Calendar.

Both `SERVICE_BOOKING_SQUARE_ENABLED=true` and `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true` are required for a usable new public payment session. If direct payment configuration is missing or disabled, the customer flow fails closed. It does not create a new Square Payment Link.

The hosted return, webhook, and finalizer remain to reconcile historical checkout records. `POST /api/booking/checkout` is a noncanonical compatibility route: the current UI does not call it, but it remains technically capable of creating a Payment Link from a valid active hold. Operators must not invoke it for a new booking. A browser return is never proof of payment. All Square flows use the single signed webhook at `/api/webhooks/square`.

Follow `docs/square-service-booking-setup.md` for credentials, subscriptions, sandbox verification, emergency stops, and reconciliation.

## 6. Sanity and training scheduling

Sanity remains appropriate for public/editorial content. For paid training intro calls, configure the training program's checkout fields, Google Appointment Schedule URL, display mode, and optional instructions in Studio. The schedule URL is revealed only after the app verifies a paid private enrollment token.

Training Appointment Schedule links do not participate in service availability, resource holds, service payments, or service Calendar event creation. See `docs/booking-training-calendar-configuration-guide.md`. The optional training Afterpay invoice path is documented in `docs/training-afterpay-square-invoice.md`.

Never store customer contact details, consent evidence, payment identifiers, holds, appointments, enrollment tokens, or transaction history in Sanity.

## 7. Verification

Run source checks before a deployment:

```bash
npm run lint
npm run test:unit
npm run check:square-card-on-file-env
npm run build
```

Use `TEST_DATABASE_URL` from a protected environment when running DB-backed tests:

```bash
npm run test:unit:db
```

Focused browser coverage for the current payment handoff is:

```bash
npx playwright test tests/booking-card-on-file-config.spec.ts --project=chromium
npx playwright test tests/service-booking-payment-page.spec.ts --project=chromium
```

In Square sandbox, verify one real provider flow in staging:

- `/booking` redirects to the intended canonical service route.
- The hold response contains an opaque payment URL and no customer/payment fields were sent to the hold endpoint.
- The payment page tokenizes with `CHARGE_AND_STORE` and calls `/api/booking/payment/confirm`.
- The response reports a captured payment and either a booked appointment or an explicit manual-follow-up state.
- PostgreSQL contains one payment/appointment outcome and Google Calendar contains one event.
- Duplicate submission, webhook delivery, and reconciliation do not create a second charge, appointment, or event.
- With direct payment disabled, new sessions fail closed while an existing historical hosted record can still be reconciled.

Use `docs/booking-system-runbook.md` for operator checks, incident handling, no-show actions, and stop conditions. Use `docs/launch-readiness-checklist.md` for the broader release smoke matrix.

## Production handoff

Do not enable production booking until all of the following are true:

- Database migration checks pass against the production target.
- `/admin/setup` has no unresolved readiness issues for the resources being activated.
- Production Auth.js and Calendar OAuth redirect URIs match the deployed origin.
- Each active provider has a healthy encrypted Calendar connection, canonical destination Calendar, schedule, active offering, and valid Square team mapping where required.
- Production Square credentials, location, application ID, webhook URL, and signature key are from the same application/environment.
- The shared webhook verifies signatures and the 30-minute payment-reconciliation cron is authorized.
- Square sandbox staging tests prove capture, saved-card/policy evidence, idempotent finalization, Calendar projection, and a controlled failure path.
- Transactional emails and private consent records are verified without writing PII to Sanity or release artifacts.

Related current documents:

- `docs/booking-system-runbook.md`
- `docs/booking-operations-dashboard.md`
- `docs/google-calendar-oauth-env-setup.md`
- `docs/booking-training-calendar-configuration-guide.md`
- `docs/square-service-booking-setup.md`
- `docs/private-database-migration-runbook.md`
- `docs/training-afterpay-square-invoice.md`
- `docs/resend-transactional-email-setup.md`
- `docs/launch-readiness-checklist.md`
