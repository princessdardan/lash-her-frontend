# Booking Operations Dashboard

The multi-provider booking system uses PostgreSQL for operational configuration and booking state, while Sanity remains the source for public/editorial service content. Google Calendar is an external projection and busy-time source; PostgreSQL resource reservations and appointments are authoritative.

## Authentication decision

The dashboard is self-hosted with Auth.js and Google OpenID Connect. Clerk is not used and must not be added.

- Google identity sign-in requests only `openid profile email`.
- PostgreSQL `admin_users` controls role and active/disabled status.
- PostgreSQL `admin_user_resources` limits employees to assigned booking resources.
- `ADMIN_OWNER_EMAILS` is bootstrap/break-glass configuration, not the normal role store.
- Booking-calendar authorization is a separate OAuth grant. Calendar refresh tokens never enter the Auth.js JWT/session and are encrypted with `BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY`.

Required identity variables are documented in `.env.local.example`:

```text
AUTH_SECRET
AUTH_GOOGLE_ID
AUTH_GOOGLE_SECRET
ADMIN_OWNER_EMAILS
```

Create separate Google OAuth clients for identity and booking-calendar access so identity sessions never receive Calendar scopes.

- Identity client callback: `https://<host>/api/auth/callback/google`
- Calendar client callback: the exact server-only `GOOGLE_REDIRECT_URI`, currently `/api/booking/oauth/callback` on the selected host

## Data ownership

| Concern | Authority |
| --- | --- |
| Service description, imagery, SEO, intake copy | Sanity |
| Provider/resource status and assignment | PostgreSQL |
| Provider-specific offering price, duration, buffer, add-ons | PostgreSQL |
| Weekly schedules and exceptions | PostgreSQL |
| Calendar connections and canonical calendar IDs | PostgreSQL, with encrypted credentials |
| Holds, resource occupancy, appointments, payment attempts | PostgreSQL |
| Busy events and appointment event projection | Google Calendar |
| Card/payment processing | Square |

The browser receives a public offering ID and display data only. It never supplies provider-resource routing, a connection ID, or a calendar ID.

## Safe deployment order

1. Back up the target database and verify PITR/restore readiness.
2. Apply migrations before deploying code:

   ```bash
   npm run db:migrate
   ```

   The migration runner commits each journal entry independently. PostgreSQL requires this when a later migration uses an enum value introduced by an earlier migration.

3. Deploy with `SERVICE_BOOKING_MODEL_MODE=dual` for the compatibility period.
4. Sign in at `/admin` with the configured bootstrap owner Google account.
5. Stage the current Nataliea configuration with the legacy import below, or create it through the dashboard.
6. Connect and assign a writable canonical Google Calendar.
7. Confirm setup readiness, then activate the resource/provider, services, and offerings.
8. Run the sandbox smoke matrix before enabling live traffic.
9. After legacy holds have expired or finalized and every public service is migrated, set `SERVICE_BOOKING_MODEL_MODE=operational`. This disables creation of new V1 holds while existing V1 payments/finalizers remain recoverable.

`legacy` is an emergency rollback mode for new booking creation. `dual` permits per-service migration. `operational` is the final cutover mode.

## Dry-run-first Nataliea import

The import reads published bookable services and booking settings from Sanity. It stages new operational rows as draft, preserves the activation state of existing rows, does not duplicate schedules, and is idempotent.

Dry run:

```bash
npm run booking:bootstrap-legacy -- \
  --provider-name Nataliea \
  --provider-slug nataliea \
  --effective-from YYYY-MM-DD
```

After reviewing the printed services, prices, add-ons, and schedule count:

```bash
npm run booking:bootstrap-legacy -- \
  --provider-name Nataliea \
  --provider-slug nataliea \
  --effective-from YYYY-MM-DD \
  --execute
```

The write command requires `DATABASE_URL`, `PRIVATE_DB_MIGRATION_TARGET`, and an exact `PRIVATE_DB_MIGRATION_HOST` match. Production also requires the one-time `BOOKING_BOOTSTRAP_CONFIRM=production` guard.

The import deliberately does not copy the legacy `primary` calendar alias or global OAuth token. The owner must connect the Google account in `/admin/calendar-connections` and choose a canonical calendar returned by Google CalendarList. This prevents ambiguous routing once more than one employee exists.

## Owner workflow

The dashboard provides these operational areas:

- `/admin/setup`: configuration/readiness summary and global defaults.
- `/admin/staff`: owner/admin/employee profiles, resources, and employee resource assignments.
- `/admin/offerings`: Sanity-linked base services and provider-specific prices, durations, buffers, and add-ons.
- `/admin/schedules`: weekly shifts, split shifts, closures, and availability exceptions.
- `/admin/calendar-connections`: connect/reconnect Google accounts and assign busy/write calendars.
- `/admin/appointments`: resource-scoped appointment operations and status history.
- `/admin/marketing`: private marketing contacts and sync health.
- `/admin/analytics`: business summary metrics.
- `/admin/audit`: owner-only administrative audit events.

New public offerings should not be activated until readiness confirms:

- the provider and primary resource are active;
- the Sanity service link and public slug are present;
- at least one active schedule exists;
- an active Calendar connection exists;
- one canonical calendar with write access receives bookings;
- all required secondary resources have schedules;
- offering price, deposit, duration, slot interval, and buffers are valid.

Unavailable schedule exceptions create database block reservations. If an existing hold or appointment overlaps, the dashboard rejects the exception instead of silently creating a conflict.

Offering-resource relationships are owner-managed on `/admin/offerings`. Required
and optional relationships apply only to future hold creation. Removing a
relationship is snapshot-safe: existing hold and appointment reservations remain
authoritative and are not released or rewritten. Activation rechecks required
resources under the same database concurrency lock used by relationship changes.

Employee resource assignment is also fail-safe. Assignment is permitted when the
employee has an active owned Calendar connection for that resource; unassignment
or account disable is rejected while it would orphan an active Calendar
assignment. Transfer or disconnect the Calendar assignment first.

Owner and employee Calendar OAuth completion share one duplicate-account state
machine. Reconnecting the same owner reuses the existing connection, a duplicate
provisional connection is disabled, an account owned elsewhere is rejected, and
newly issued refresh tokens are revoked best-effort on rejection or persistence
failure.

No-show attribution uses the actual successful charge attempt associated with
the record's Square payment ID, not the policy ceiling. When there are multiple
attempts, the matching terminal attempt wins; historical records without a
terminal attempt contribute zero; voided records are excluded. A record with
full or partial refund evidence also contributes zero because the current model
cannot calculate a trustworthy net partial-refund amount. This conservative
treatment is one reason the report is attribution-only and must not be used for
commissions, payroll, tax, or financial accounting.

## Roles

- `owner`: all access, staff/configuration management, audit, sensitive exports/refunds.
- `admin`: daily operations, configuration, calendars, marketing, analytics, and staff viewing; no owner-only audit/export/refund authority.
- `employee`: appointments and schedules for assigned resources only.

Authorization is enforced in server queries and mutations. Hiding a navigation item is not treated as authorization.

## Failure behavior

- An operational configuration read error fails closed; it does not silently switch customers to the legacy calendar.
- An active but unhealthy V2 offering is treated as unavailable, not as an unmigrated V1 service.
- Resource occupancy is protected by a PostgreSQL exclusion constraint using half-open time ranges.
- Calendar connection loss leaves the appointment/payment record recoverable and visible for manual follow-up.
- Direct payment acquires a durable capture lease before provider work. Hold and reservation expiry exclude valid leases and durable authorized/captured attempts.
- Payment attempts persist a hashed provider-request intent before Square. Same-body retries reuse the key; changed sources cancel the old intent by idempotency key before using a new one; ambiguous outcomes remain reconciliation work.
- Provider completion is persisted before appointment projection. Reconciliation verifies amount, currency, customer, reference, and Square team member against the immutable intent before resuming projection or alerting.
- Calendar events are correlated by both canonical calendar assignment and provider event ID.
- Booking-outcome emails are claimed from durable appointment state. The 30-minute payment-reconciliation cron also retries unsent outcomes oldest-first; a later booked outcome can send a corrective confirmation after an earlier manual-follow-up email without reusing the manual email idempotency key.

## Private-data retention

The existing private-data retention job also covers operational appointments. After 395 days, only terminal `completed`, `cancelled`, and `no_show` appointments are redacted; confirmed, rebooking-pending, and manual-follow-up records are preserved. Redaction removes customer identity, phone, intake details, cancellation free text, and email retry errors while retaining non-PII offering/provider snapshots, payment state, schedule timestamps, and event history needed for financial and operational records.

Never paste OAuth setup URLs, refresh/access tokens, `DATABASE_URL`, payment source tokens, or customer PII into tickets, screenshots, or chat.
