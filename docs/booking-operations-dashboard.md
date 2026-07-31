# Booking Operations Dashboard

The multi-provider booking system uses PostgreSQL for operational configuration, public catalog copy, intake content, and booking state. Sanity owns only the editorial, media, and SEO content rendered on service detail pages. Google Calendar is an external projection and busy-time source; PostgreSQL resource reservations and appointments are authoritative.

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

| Concern                                                     | Authority                              |
| ----------------------------------------------------------- | -------------------------------------- |
| Service detail-page editorial, imagery, and SEO             | Sanity                                 |
| Public service catalog title/summary and intake copy        | PostgreSQL                             |
| Provider/resource status and assignment                     | PostgreSQL                             |
| Provider-specific offering price, duration, buffer, add-ons | PostgreSQL                             |
| Weekly schedules and exceptions                             | PostgreSQL                             |
| Calendar connections and canonical calendar IDs             | PostgreSQL, with encrypted credentials |
| Holds, resource occupancy, appointments, payment attempts   | PostgreSQL                             |
| Busy events and appointment event projection                | Google Calendar                        |
| Card/payment processing                                     | Square                                 |

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
9. After legacy holds have expired or finalized and every public service is migrated, complete the operational data cutover gate below.
10. Only after the cutover command reports success, set `SERVICE_BOOKING_MODEL_MODE=operational`. This disables creation of new V1 holds while existing V1 payments/finalizers remain recoverable.

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

## Operational data cutover gate

Keep `SERVICE_BOOKING_MODEL_MODE=dual` until this gate passes. Apply the
PostgreSQL migrations and finish staging every provider/service/offering first.
The cutover import reads the published legacy Sanity booking settings and raw
service-promotion eligibility fields, but runtime operational booking remains
PostgreSQL-only.

Run the validation-only dry run:

```bash
npm run booking:import-operational-cutover
```

The command exits nonzero without writing if booking settings are missing, a
specific Sanity service cannot map by exact Sanity document ID, one Sanity ID
maps to more than one operational service record, promotion codes collide with
admin-owned PostgreSQL codes, or source values violate operational limits. One
Sanity service may map to several provider offerings; the import records every
such offering explicitly. Review the reported source promotion, referenced
service, target offering, eligibility-row, intake-question, and stale-promotion
counts.

Execute only after the dry-run counts are approved:

```bash
npm run booking:import-operational-cutover -- --execute
```

The write is transactional and idempotent. It upserts settings and
Sanity-lineage promotion codes, replaces only those imported promotions' exact
offering eligibility, disables imported promotions no longer present in the
source, and enriches provider-offering public copy from linked published
service documents. PostgreSQL tracks title and summary provenance independently.
The import can enrich only fields marked as legacy-owned; saving offering copy
in Admin marks both fields as administrator-owned, including when the saved
text happens to equal a migration fallback. Administrator-owned provider copy
is preserved on every cutover or legacy-bootstrap rerun, while legacy-owned
title and summary fields remain independently refreshable. Copy generated by
the `0025` migration remains legacy-owned until it is explicitly saved through
Admin. Existing admin-owned promotion codes are never adopted or overwritten.

The command requires `SANITY_API_READ_TOKEN`, `DATABASE_URL`,
`PRIVATE_DB_MIGRATION_TARGET`, and an exact `PRIVATE_DB_MIGRATION_HOST` match.
Production additionally requires `BOOKING_CUTOVER_CONFIRM=production` after a
backup and reviewed dry run. Do not set
`SERVICE_BOOKING_MODEL_MODE=operational` unless the execute command exits zero
and prints `CUTOVER VALIDATION PASSED`.

## Owner workflow

The dashboard provides these operational areas:

- `/admin/setup`: configuration/readiness summary and global defaults.
- `/admin/staff`: owner/admin/employee profiles, resources, and employee resource assignments.
- `/admin/offerings`: operational services, public catalog copy, provider-specific prices, durations, buffers, add-ons, and optional detail-page editorial links.
- `/admin/schedules`: weekly shifts, split shifts, closures, and availability exceptions.
- `/admin/calendar-connections`: connect/reconnect Google accounts and assign busy/write calendars.
- `/admin/appointments`: resource-scoped appointment operations and status history.
- `/admin/marketing`: private marketing contacts and sync health.
- `/admin/analytics`: business summary metrics.
- `/admin/audit`: owner-only administrative audit events.

New public offerings should not be activated until readiness confirms:

- the provider and primary resource are active;
- the operational public slug and provider-facing title/summary are present;
- any optional Sanity detail-page link resolves when configured; a missing editorial link does not block an otherwise valid offering;
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
- `employee`: appointments, schedules, and owned Google Calendar routing for
  assigned provider resources only. Employees can choose busy-only calendars
  and the booking destination for those resources but cannot access the
  business-wide Calendar administration surface.

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
