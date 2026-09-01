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

### Cross-deployment developer mode

Developer mode is an explicit break-glass capability. Configure both of these
server-only variables in each local, preview, or production environment that
requires it:

```text
ADMIN_DEVELOPER_MODE=true
ADMIN_DEVELOPER_ACCESS_KEY=<distinct high-entropy secret of at least 32 characters>
```

Use a different access key for each environment. Never prefix either variable
with `NEXT_PUBLIC_`, commit an access key, place it in a URL, or send it through
chat or tickets. Generate keys with a cryptographically secure secret manager
or `openssl rand -base64 48`.

Configure Vercel through the project Environment Variables settings or with
interactive CLI prompts so secret values do not enter shell history:

```bash
vercel env add ADMIN_DEVELOPER_MODE production
vercel env add ADMIN_DEVELOPER_ACCESS_KEY production --sensitive
vercel env add ADMIN_DEVELOPER_MODE preview
vercel env add ADMIN_DEVELOPER_ACCESS_KEY preview --sensitive
```

Enter `true` for each mode flag and a distinct generated key for each sensitive
prompt. Redeploy production and create a new preview deployment after changing
environment variables; existing deployments do not gain new values in place.

The sign-in page first requires the deployment's developer access key, then
provides a developer session that:

- bypasses Google identity authentication;
- can represent any PostgreSQL `admin_users` record, including a disabled one;
- independently simulates owner, administrator, or contractor permissions;
- keeps the selected user ID on writes so on-behalf-of behavior can be tested;
- records each developer-session start in the administrative audit log;
- marks mutation audit metadata with `developerMode`, the represented account's
  stored role, and the simulated permission role.

The mode fails closed unless both variables are valid. The submitted key is
compared in constant time and is not copied into cookie or session state. It
signs an HTTP-only, SameSite=Strict unlock cookie lasting 15 minutes and an
HTTP-only, SameSite=Strict developer session lasting 30 days; deployed cookies
also use the Secure flag. Session contents are rejected if altered, expired,
signed for a different purpose, or signed by a rotated key. Rotating the
environment's access key immediately invalidates every developer session for
that deployment.

Disable the capability by setting `ADMIN_DEVELOPER_MODE=false` or removing both
variables, then redeploy. While enabled locally, bind the development server to
loopback with `npm run dev -- --hostname 127.0.0.1` and do not expose it through
a LAN, port-forward, or public tunnel.

Create separate Google OAuth clients for identity and booking-calendar access so identity sessions never receive Calendar scopes.

- Identity client callback: `https://<host>/api/auth/callback/google`
- Calendar client callback: the exact server-only `GOOGLE_REDIRECT_URI`, currently `/api/booking/oauth/callback` on the selected host

## Data ownership

| Concern                                                     | Authority                              |
| ----------------------------------------------------------- | -------------------------------------- |
| Service detail-page editorial, imagery, and SEO             | Sanity                                 |
| Public service catalog title/summary and intake copy        | PostgreSQL                             |
| Staff provider identity and booking status                  | PostgreSQL                             |
| Provider-specific offering price, duration, buffer, add-ons | PostgreSQL                             |
| Weekly schedules and exceptions                             | PostgreSQL                             |
| Calendar connections and canonical calendar IDs             | PostgreSQL, with encrypted credentials |
| Holds, resource occupancy, appointments, payment attempts   | PostgreSQL                             |
| Busy events and appointment event projection                | Google Calendar                        |
| Card/payment processing                                     | Square                                 |

The browser receives a public offering ID and display data only. It never supplies provider-resource routing, a connection ID, or a calendar ID.

The public `/services` catalog and `/services/[slug]/booking` flow read operational offering and intake data from PostgreSQL. `/booking` is a permanent legacy redirect shim: the bare path redirects to `/services`, valid legacy offering links redirect to the canonical service booking route, and invalid legacy parameters fail closed. Sanity `service` documents may supply linked detail-page editorial content, imagery, and SEO, but they do not own operational booking availability or pricing.

The legacy Sanity `bookingSettings` schema file remains in the repository for V1 runtime/recovery compatibility and one-time imports. It is not registered in the active Studio schema, structure, or Presentation configuration, and operators must not recreate or edit it as current runtime configuration.

## Calendar credential ownership

Owners and administrators start operational OAuth connections at `/admin/calendar-connections`; employees use `/admin/my-calendar`. The callback persists connection credentials encrypted with `BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY` in PostgreSQL and assigns calendars through resource-scoped operational records.

Redis/KV still stores short-lived OAuth state and coordination locks. The protected `BOOKING_ADMIN_SETUP_SECRET` flow and its Redis-backed global refresh token remain only for V1 compatibility and legacy recovery; they are not the setup path for new operational connections.

## Current deployment order

1. Back up the target database and verify PITR/restore readiness.
2. Inspect migration lineage, apply reviewed migrations with explicit target guards, then confirm the target is current before deploying code:

   ```bash
   npm run db:check -- --env-file <protected-env-file>
   DOTENV_CONFIG_PATH=<protected-env-file> \
   PRIVATE_DB_MIGRATION_TARGET=TARGET_NAME \
   PRIVATE_DB_MIGRATION_HOST=EXACT_DATABASE_HOST \
   npm run db:migrate
   npm run db:check -- --env-file <protected-env-file>
   ```

   Replace `<protected-env-file>`, `TARGET_NAME`, and `EXACT_DATABASE_HOST` with the reviewed target values. A pre-apply exit code of 1 is expected when the only finding is the reviewed pending migration set. Production also requires `PRIVATE_DB_MIGRATION_CONFIRM=production` on the migration command. The migration runner commits each journal entry independently. PostgreSQL requires this when a later migration uses an enum value introduced by an earlier migration. Follow `docs/private-database-migration-runbook.md`; do not rely on whichever `DATABASE_URL` happens to be present in a default `.env` file.

3. Deploy current environments with `SERVICE_BOOKING_MODEL_MODE=operational`. Do not switch an already-operational environment back to `dual` for routine deployment.
4. Sign in at `/admin` with the configured bootstrap owner Google account.
5. Create and verify the current provider, resources, services, offerings, schedules, and settings through the dashboard.
6. Connect and assign a writable canonical Google Calendar.
7. Confirm setup readiness, then activate the resource/provider, services, and offerings.
8. Run the sandbox smoke matrix before enabling live traffic.

`legacy` and `dual` remain compatibility modes for an explicitly approved migration or emergency recovery plan. Both permit V1 API booking creation and are not safe defaults for a current operational deployment. Existing holds and payment records continue through their stored model version without reopening V1 creation.

## Historical migration/recovery: legacy Nataliea import

Do not run this procedure during routine deployment or switch a current environment back to `dual`. It exists only for a deployment that has not completed the legacy-to-operational migration or for an approved recovery of verified legacy source data.

The compatibility import reads legacy published bookable services and the legacy booking-settings document from Sanity. Those source schemas are not operational authority, and `bookingSettings` is intentionally absent from the active Studio. The import stages new PostgreSQL rows as draft, preserves the activation state of existing rows, does not duplicate schedules, and is idempotent.

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

## Historical migration/recovery: operational data cutover gate

For a deployment that has never completed the legacy-to-operational cutover,
keep `SERVICE_BOOKING_MODEL_MODE=dual` only for the duration of this migration
procedure. Never switch an already-operational deployment back to `dual`. Apply
the PostgreSQL migrations and finish staging every provider/service/offering first.
The one-time compatibility cutover import reads the published legacy Sanity
booking settings and raw service-promotion eligibility fields, but those source
documents are not editable operational configuration and runtime operational
booking remains PostgreSQL-only.

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

- `/admin`: role-scoped operational overview.
- `/admin/setup`: booking-health and readiness summary.
- `/admin/booking-settings`: public booking defaults, policy, lead-time, and intake configuration.
- `/admin/staff`: owner/admin/employee accounts, their automatically provisioned provider profiles, booking status, and Square attribution.
- `/admin/offerings`: operational services, public catalog copy, provider-specific prices, durations, buffers, add-ons, and optional detail-page editorial links.
- `/admin/service-promotions`: PostgreSQL-owned promotion codes and exact offering eligibility.
- `/admin/schedules`: weekly shifts, split shifts, closures, and availability exceptions.
- `/admin/calendar-connections`: connect/reconnect Google accounts and assign busy/write calendars.
- `/admin/my-calendar`: employee-owned Google Calendar connection and routing.
- `/admin/appointments` and `/admin/appointments/[id]`: resource-scoped appointment operations and status history.
- `/admin/booking-issues`: booking and reconciliation conditions that require manual follow-up.
- `/admin/inquiries`: private contact and service-inquiry operations.
- `/admin/orders`: product-order operations.
- `/admin/inventory`: product inventory operations.
- `/admin/shipping-packages`: package-profile configuration.
- `/admin/training`: training enrollment operations.
- `/admin/payments`: payment and refund views.
- `/admin/marketing`: private marketing contacts and sync health.
- `/admin/integrations`: integration status and operational configuration visibility.
- `/admin/analytics`: business summary metrics.
- `/admin/audit`: owner-only administrative audit events.

`/admin/step-up` is the internal privileged-action verification route rather than a standalone operational workspace. Every route above remains permission-gated; its presence in this inventory does not imply access for every role.

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
  their implicit provider profile. Employees can choose busy-only calendars
  and the booking destination for that profile but cannot access the
  business-wide Calendar administration surface.

Authorization is enforced in server queries and mutations. Hiding a navigation item is not treated as authorization.

## Failure behavior

- An operational configuration read error fails closed; it does not silently switch customers to the legacy calendar.
- An active but unhealthy V2 offering is treated as unavailable, not as an unmigrated V1 service.
- The public payment config/form uses direct Square `CHARGE_AND_STORE` for the configured deposit, full amount, or custom partial amount. If that direct configuration is unavailable, the form fails closed; it does not create a hosted Payment Link.
- Resource occupancy is protected by a PostgreSQL exclusion constraint using half-open time ranges.
- Calendar connection loss leaves the appointment/payment record recoverable and visible for manual follow-up.
- Direct payment acquires a durable capture lease before provider work. Hold and reservation expiry exclude valid leases and durable authorized/captured attempts.
- Payment attempts persist a hashed provider-request intent before Square. Same-body retries reuse the key; changed sources cancel the old intent by idempotency key before using a new one; ambiguous outcomes remain reconciliation work.
- Provider completion is persisted before appointment projection. Reconciliation verifies amount, currency, customer, reference, and Square team member against the immutable intent before resuming projection or alerting.
- Calendar events are correlated by both canonical calendar assignment and provider event ID.
- Booking-outcome emails are claimed from durable appointment state. The 30-minute payment-reconciliation cron also retries unsent outcomes oldest-first; a later booked outcome can send a corrective confirmation after an earlier manual-follow-up email without reusing the manual email idempotency key.

## Private-data retention

The existing private-data retention job also covers operational appointments. After 395 days, only terminal `completed`, `cancelled`, and `no_show` appointments are redacted; confirmed, rebooking-pending, and manual-follow-up records are preserved. Redaction removes customer identity, phone, intake details, cancellation free text, and email retry errors while retaining non-PII offering/provider snapshots, payment state, schedule timestamps, and event history needed for financial and operational records.

See `docs/scheduled-jobs-runbook.md` for retention and reconciliation endpoint authentication, cadence ownership, and failure behavior.

Never paste legacy OAuth setup URLs, refresh/access tokens, `DATABASE_URL`, payment source tokens, or customer PII into tickets, screenshots, or chat.

## Related runbooks

- `docs/booking-system-setup-guide.md`: environment and rollout setup.
- `docs/booking-system-runbook.md`: live booking operations and recovery.
- `docs/square-service-booking-setup.md`: Square charge-and-store and historical reconciliation setup.
- `docs/scheduled-jobs-runbook.md`: scheduled endpoint contracts and ownership.
- `docs/production-cutover-checklist.md`: staging-to-production cutover procedure.
