# Booking and Training Calendar Configuration Guide

Last verified: 2026-08-31

Service booking and paid training intro-call scheduling are separate systems:

| Flow                     | Public configuration                                                          | Private authority                                                                                               | Calendar behavior                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Service booking          | Operational services/settings from PostgreSQL; optional Sanity editorial link | PostgreSQL resources, offerings, schedules, holds, payments, appointments, Calendar connections and assignments | App calculates slots, reads assigned busy Calendars, and creates the confirmed event through the Google Calendar API |
| Paid training intro call | Sanity training-program checkout fields and a Google Appointment Schedule URL | PostgreSQL paid enrollment and hashed schedule token                                                            | After token verification, app exposes Google's Appointment Schedule link/embed; Google handles time selection        |

Do not use a Google Appointment Schedule as the service-booking engine. Do not use service booking holds or `/api/booking/payment/confirm` for training intro-call scheduling.

## Configure service booking

### 1. Prepare the environment

From the repository root:

```bash
npm install
npm run db:check -- --env-file <protected-env-file>
```

Do not run a bare `npm run db:migrate`. Apply changes only with the exact target/host/env-file guards in `docs/private-database-migration-runbook.md`; production additionally requires `PRIVATE_DB_MIGRATION_CONFIRM=production`. Rerun `db:check` after the guarded migration.

Configure the server-only database, Auth.js identity, Calendar OAuth, Calendar credential encryption, Upstash, Square, reconciliation, and email variables from `.env.local.example`. For a fully cut-over deployment, set:

```env
SERVICE_BOOKING_MODEL_MODE=operational
```

Use `docs/google-calendar-oauth-env-setup.md` for the Google client and encryption-key procedure. Use `docs/square-service-booking-setup.md` for payment credentials and webhooks.

### 2. Create providers and resources

Open `/admin/staff`:

1. Create or activate each team member that should accept online bookings. Each team account has a bookable provider resource.
2. Confirm the client-facing provider name and public slug.
3. On **Square sales matching**, map the provider to the correct Square team member when attribution is required.

Provider/resource identity is selected by the server. Public hold requests must not be allowed to choose arbitrary resource or employee IDs.

### 3. Save business booking settings

Open `/admin/booking-settings` and review:

- Business timezone.
- Minimum booking notice and future booking window.
- Appointment interval and default timing/buffers.
- Client intake questions.
- Marketing opt-in wording.

These settings are private PostgreSQL operational configuration. The legacy Sanity `bookingSettings` document is not the runtime source for current service booking.

### 4. Create services and provider offerings

Open `/admin/offerings`:

1. Create the service with a route-safe public slug and complete client-facing title/summary.
2. Create a provider-specific offering with the price, duration, pre/post buffers, and active status.
3. Confirm the offering uses the provider's automatically managed primary resource.
4. Configure any add-ons with complete public name, key, description, positive price, and duration delta.
5. Activate the provider, service, offering, resource, and add-ons only after their readiness inputs are complete.

An optional Sanity service link may supply richer editorial detail or SEO. It does not own price, duration, resources, availability, or payment state.

### 5. Configure resource schedules

Open `/admin/schedules`:

1. Add active weekly hours for the provider resource.
2. Record time off and extra-hours exceptions in the business timezone.
3. Verify effective dates and prevent overlapping or contradictory schedules.

Operational availability intersects all required resource schedules, active reservations, and assigned Google Calendar busy intervals. A missing required schedule causes the offering to fail closed.

### 6. Connect and assign Calendars

Owners/administrators use `/admin/calendar-connections`. Employees use `/admin/my-calendar` for their assigned resources.

1. Select **Connect Google account** and complete the permission-protected OAuth flow.
2. Confirm the account becomes active and Calendar discovery succeeds.
3. Assign a discovered canonical Calendar ID to the resource. The alias `primary` is not valid stored configuration.
4. Choose one Calendar as the booking destination. Google access must be `writer` or `owner`; the destination also contributes busy time.
5. Add busy-only Calendars where useful. They require at least free/busy access and do not receive new appointments.
6. Move the booking destination before disabling its assignment, disconnecting the account, or transferring ownership.

Refresh credentials are encrypted and stored with each connection in private PostgreSQL. Upstash holds only the expiring OAuth state. The legacy global secret/Redis credential route is compatibility-only and must not be used for a new operational provider.

### 7. Check readiness and public routes

Open `/admin/setup` and clear every issue for the provider. Activation is blocked or unhealthy when any of these are missing:

- Active provider and primary resource.
- Provider display name and public slug.
- Active service and public slug.
- Complete public offering title/summary.
- Active provider offering.
- Active weekly schedule for the provider resource.
- Active booking Calendar destination.
- Complete active add-ons.

If migrated operational data already assigns a required room/equipment resource, readiness also requires that persisted resource to be active and scheduled. The current dashboard does not create or attach secondary resources; do not repair that state with an ad hoc SQL edit. Use an audited migration or add the required admin capability. Square team mappings are managed on `/admin/staff?tab=square`; the requirement/readiness control is on `/admin/integrations`.

Verify the canonical routes:

- `/services` lists active operational offerings.
- `/services/[slug]/booking` displays provider offerings and availability.
- `/booking` permanently redirects to `/services`.
- `/booking?service=<slug>` and the accepted legacy slug aliases redirect to `/services/<slug>/booking` only for a currently bookable operational slug.

### 8. Verify hold and payment behavior

Use Square sandbox in staging:

1. Select a provider offering and time.
2. Confirm `POST /api/booking/holds` revalidates availability, reserves all required resources, and returns an opaque `/services/[slug]/booking/payment?session=...` URL.
3. Confirm the hold request contains offering/time/intake choices only. Contact, marketing, policy, and payment data belong on the payment step and are rejected by the hold endpoint. Resource, employee, Calendar, and connection routing fields must never be supplied by the browser; the server selects them.
4. On the payment page, confirm Square tokenization uses `CHARGE_AND_STORE` and the form posts to `/api/booking/payment/confirm`.
5. Confirm the server captures the selected amount, stores provider/policy/saved-card evidence, creates one PostgreSQL appointment, and creates one event on the resource's booking destination.
6. Retry safely and deliver duplicate webhooks; confirm no duplicate charge, appointment, reservation transfer, or Calendar event appears.

Direct `/api/booking/create` is intentionally disabled. New bookings must not bypass payment reconciliation.

## Configure a paid training intro-call schedule

### 1. Create the Google Appointment Schedule

In the Google Calendar account used for training calls:

1. Create an Appointment Schedule for the intro call.
2. Configure availability, duration, buffers, booking limits, meeting details, and notifications in Google.
3. Copy the public schedule URL. It must use this form:

   ```text
   https://calendar.google.com/calendar/appointments/schedules/<schedule-id>
   ```

The app validates the scheme, host, and path before exposing the URL. This public schedule is not a service-booking Calendar assignment and does not require the app's per-resource Calendar connection unless the same Google account is also used independently for service booking.

### 2. Configure the training program in Sanity Studio

Open the training program's checkout group in `/studio` and configure:

- Availability and checkout fields required by the program's paid checkout.
- `introCallAppointmentScheduleUrl` with the copied Google URL.
- `introCallAppointmentScheduleEmbedMode` as `link` or `embed`.
- Optional `introCallSchedulingInstructions`.

Publish the program after validation succeeds. The `link` mode opens Google in a new tab. The `embed` mode renders an iframe on larger screens and a popup button on mobile.

### 3. Understand the token gate

The schedule route is:

```text
/training-programs/[slug]/schedule?token=<opaque-token>
```

After Square captures the training checkout, or an enabled Square training invoice reaches paid state, PostgreSQL marks the enrollment paid and issues an opaque scheduling token. Only its hash is stored. The current token lifetime is 14 days.

Before rendering the Google URL, the route verifies that:

- The token is present and structurally acceptable.
- A paid private enrollment matches the token.
- The enrollment belongs to the requested program slug.
- The token has not expired or already been consumed by the scheduling workflow.
- The Sanity program contains a valid Appointment Schedule URL.

Invalid, unpaid, expired, used, or wrong-program tokens show the same safe unavailable page and do not render the Google URL through this app route. The route is dynamic, uncached, and marked `noindex`/`nofollow`.

Rendering the schedule page does not itself mark an enrollment scheduled, and Google Appointment Schedule completion is not synchronized back to the app automatically. `/admin/training` reports the local enrollment state that exists; it is not currently an appointment-completion control.

The Appointment Schedule URL is stored in and projected from the public Sanity content layer. The token gate controls exposure through the Lash Her scheduling route; it does not make the URL confidential against direct Sanity API access. If strict paid-only secrecy is required, move the URL to private PostgreSQL or another private store before relying on it as a secret.

### 4. Verify training scheduling

In staging:

1. Confirm an unpaid enrollment cannot obtain or use the scheduling page.
2. Complete a Square sandbox training payment and verify the notification contains the tokenized schedule URL.
3. Open the URL and confirm the correct program title, instructions, and Google schedule appear.
4. Confirm `link` mode opens a separate tab and `embed` mode uses the responsive iframe/popup behavior.
5. Test a modified token, wrong slug, expired token, missing URL, and extra query parameter; none may expose the Google URL.
6. Confirm opening the page alone does not change the enrollment to scheduled.

Primary training checkout uses Square Web Payments when `SQUARE_COMMERCE_ENABLED=true`. The optional training Afterpay Square Invoice path is documented in `docs/training-afterpay-square-invoice.md`. Both keep enrollment and token state in private PostgreSQL and share `/api/webhooks/square` with other Square flows.

## Common configuration errors

| Symptom                                              | Check                                                                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Service absent from `/services`                      | Service/provider/offering status, public fields, schedule, resources, Calendar destination, and `/admin/setup` blockers                                                                                      |
| No available times                                   | Business/resource schedules, exceptions, required-resource reservations, Google busy events, Calendar connection health, and booking window settings                                                         |
| Calendar can block time but cannot receive bookings  | Google access role; a destination requires `writer` or `owner`                                                                                                                                               |
| Event lands on the wrong Calendar                    | Resource's active `acceptsBookings` assignment and canonical Calendar ID                                                                                                                                     |
| Payment page has no card form                        | Both service Square flags, required `DATABASE_URL` setting, application/location IDs, and Square environment alignment; actual database connectivity failures surface during session/confirmation operations |
| Training schedule always unavailable                 | Paid enrollment/token state, exact program slug, 14-day expiry, published Sanity URL, and URL host/path validation                                                                                           |
| App route renders a training schedule before payment | The route must resolve private paid-token eligibility before rendering the Google schedule; note that the URL itself remains public Sanity content                                                           |
