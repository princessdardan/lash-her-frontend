# Booking System Runbook

Last verified: 2026-08-31

Use this runbook to operate and troubleshoot the current PostgreSQL-backed booking, payment, and Calendar flows. The canonical customer journey is operational service selection, a private resource hold, an opaque payment handoff, Square direct `CHARGE_AND_STORE`, captured-payment persistence, authoritative appointment creation, and Google Calendar projection through the provider primary resource.

The current public UI does not create Square hosted checkouts. Historical Payment Link return/webhook records remain reconcilable. The compatibility checkout endpoint is still deployed and technically capable of creating a Payment Link; operators and current UI code must not invoke it for a new booking.

## System boundaries

| System                      | Current responsibility                                                                                                                                                                                                                                     | Must not become                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Private PostgreSQL          | Admin users/roles, business booking settings, services/offerings, resources, schedules/exceptions, Calendar connections/assignments, holds/reservations, customer/policy/payment evidence, appointments, training enrollments/tokens, reconciliation state | Public browser-readable database or editorial CMS                                                                         |
| Sanity                      | Optional service editorial detail/media/SEO and public training-program configuration, including the paid intro-call Appointment Schedule URL                                                                                                              | Service prices/availability authority or storage for PII, consent, holds, payments, appointments, tokens, or transactions |
| Upstash Redis               | Short-lived OAuth state, contention locks, rate-limit windows, and active-hold quotas                                                                                                                                                                      | Canonical appointment, payment, identity, or current Calendar credential storage                                          |
| Google Calendar API         | Busy intervals from assigned resources and one booking destination for each provider primary resource; event projection after payment capture                                                                                                              | Payment verifier or service catalog                                                                                       |
| Google Appointment Schedule | Time selection for a paid training intro call after the app verifies a private enrollment token                                                                                                                                                            | Service-booking engine or proof that training payment succeeded                                                           |
| Square                      | Direct service authorization/capture/card storage, no-show invoices, product/training card payments, optional training Afterpay invoice, refunds, webhooks, and historical hosted reconciliation                                                           | Sole proof of booking success or storage destination for app-only policy/appointment state                                |
| Resend                      | Customer/admin transactional delivery and marketing-contact synchronization                                                                                                                                                                                | Authority for a booking, payment, enrollment, or consent decision                                                         |

The `payment_provider` enum retains `helcim` for migrated historical records. There are no current `helcim_*` columns and no code path creates a new Helcim payment. Historical data is read through the provider-neutral PostgreSQL schema.

## Provider map

| Flow                       | Payment path                                                                                                                       | Scheduling path                                                | Private authority                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Paid service booking       | Square Web Payments `CHARGE_AND_STORE`, Payments authorize/capture, saved card, and a draft no-show invoice when a balance remains | Lash Her slot UI plus assigned Google Calendar API connections | PostgreSQL holds, reservations, payment intent/evidence, appointment, Calendar state |
| Product checkout           | Square Web Payments one-time card charge when `SQUARE_COMMERCE_ENABLED=true`                                                       | None                                                           | PostgreSQL order, payment obligations/transactions, inventory and fulfillment state  |
| Primary training checkout  | Square Web Payments one-time card charge when `SQUARE_COMMERCE_ENABLED=true`                                                       | Paid token gate, then Google Appointment Schedule              | PostgreSQL order, paid enrollment, hashed scheduling token                           |
| Optional training Afterpay | Square Invoice when `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`                                                                | Same paid token gate and Appointment Schedule                  | PostgreSQL order/enrollment and webhook-verified invoice state                       |

All Square flows use one signed endpoint, `/api/webhooks/square`. Event routing must preserve the boundaries above: commerce and training events must not fall through as service bookings, no-show events must correlate to their stored record, and historical hosted records must remain lookup/reconciliation work rather than a new checkout path.

## Current service-booking flow

### Entry and availability

1. `/services` loads active public operational offerings from PostgreSQL.
2. `/services/[slug]/booking` loads operational booking UI settings and offerings from PostgreSQL.
3. `/booking` permanently redirects to `/services`; accepted legacy slug query aliases redirect to the canonical service booking route only when the operational slug is currently bookable.
4. `/api/booking/availability` resolves the operational offering on the server and intersects booking window/settings, every required resource's schedule and exceptions, active PostgreSQL reservations/holds, and busy events from each active resource Calendar assignment.
5. Missing operational configuration fails closed. The browser cannot select an employee, Calendar connection, or resource ID directly.

### Hold and opaque payment handoff

1. `POST /api/booking/holds` accepts the operational offering, selected time/add-on, source path, and bounded intake answers.
2. The server revalidates availability and atomically reserves the provider plus every required room/equipment resource for ten minutes.
3. The endpoint returns an opaque payment reference and `/services/[slug]/booking/payment?session=...` URL.
4. Name, email, phone, marketing choice, policy evidence, payment option, and payment data are rejected at the hold step. Those fields belong only on the payment page.
5. Direct `/api/booking/create` is intentionally disabled; there is no unpaid direct appointment-creation path.

Treat the payment-session reference as sensitive. It is an unguessable lookup capability, not an identifier to put in logs, tickets, analytics, or documentation.

### Direct Square confirmation

1. The payment page resolves the opaque reference server-side and displays the trusted offering/payment snapshot.
2. The customer provides contact details, deposit/full/custom partial selection, marketing choice, and explicit no-show policy acceptance.
3. Square Web Payments tokenizes in Square's iframe with `verificationDetails.intent = "CHARGE_AND_STORE"`.
4. The form sends the source token, verification token, a fresh client idempotency key, expected amount, customer data, and policy evidence to `POST /api/booking/payment/confirm`.
5. The server recomputes the allowed amount, persists customer/payment selection, creates or reuses the Square customer, and claims a durable provider request intent plus a five-minute capture lease.
6. Square creates an `APPROVED` authorization. The app saves the card, persists policy/no-show evidence, and creates a DRAFT no-show invoice when a deposit/partial payment leaves an eligible balance.
7. The server persists authorization evidence, revalidates the capture lease and reservation set immediately before capture, then completes the Square payment.
8. Provider `COMPLETED` evidence is stored before appointment projection.
9. The finalizer transfers the reservations to one authoritative appointment and creates or finds one event on the assigned booking destination Calendar.
10. The API returns `paymentStatus: "captured"` and `bookingStatus: "booked"` or `"manual_followup"`. Transactional email is a non-blocking side effect after the durable transition.

For an identical retry, the server reuses persisted provider idempotency state. If the request body/source changes while a prior attempt is ambiguous, it first cancels by the old idempotency key and terminates that intent before using a new provider key. Never bypass this by manually issuing another charge.

If direct card collection/config is disabled, the public payment page fails closed. It does not call `/api/booking/checkout`. Keep valid service Square credentials and webhook/reconciliation enabled so existing direct attempts and historical hosted records can finish safely.

### Historical hosted reconciliation

`/api/booking/square/return` and the hosted branch of the Square webhook/finalizer exist for records created by the former Payment Link flow. `POST /api/booking/checkout` is a noncanonical compatibility endpoint: the current UI does not call it, but the route remains capable of creating a new Payment Link from a valid active hold. Do not call it for a new booking. If the product intends to make historical reconciliation the only hosted capability, gate or remove that creation route in code.

- Do not route a new customer into these endpoints.
- A browser return and its query values are lookup hints, not paid evidence.
- Finalization must query/verify Square and match local order/hold, amount, currency, customer/reference, and provider identity.
- Duplicate returns and webhooks must resolve to the same local record and Calendar event.
- A verified paid record whose original slot can no longer be projected remains `paid_unbookable_rebooking_pending`: rebook first, refund only after rebooking fails or an authorized operator chooses refund.

## Paid training scheduling

1. Square card capture or an enabled Square training invoice marks the private order/enrollment paid.
2. The app issues an opaque schedule token and stores its hash; the current lifetime is 14 days.
3. The customer opens `/training-programs/[slug]/schedule?token=...`.
4. The server verifies the private paid enrollment, exact program slug, token validity/expiry/usage, and published Sanity Appointment Schedule URL.
5. Only after verification does the page render Google's link or embed through the Lash Her route.

Opening the page does not itself mark the enrollment scheduled. Invalid, unpaid, expired, used, or wrong-program tokens must not render the Google URL through this app route. The URL is nevertheless projected from the public Sanity content layer, so the token gate is an application-flow gate rather than a confidentiality boundary. Strict paid-only secrecy would require moving the URL to a private store. Google Appointment Schedule is not used to compute service availability or create service holds.

See `docs/booking-training-calendar-configuration-guide.md` and `docs/training-afterpay-square-invoice.md`.

## Operational dashboards

| Page                          | Use during operation                                                      |
| ----------------------------- | ------------------------------------------------------------------------- |
| `/admin/setup`                | Computed provider/service readiness; first check for missing setup        |
| `/admin/appointments`         | Appointment status, attendance, Calendar result, authorized staff actions |
| `/admin/booking-issues`       | Incomplete booking/payment/Calendar outcomes needing investigation        |
| `/admin/payments`             | Payment/refund operational view                                           |
| `/admin/calendar-connections` | Owner/admin connection health, destinations, busy assignments, errors     |
| `/admin/my-calendar`          | Employee connection and assignment controls for owned resources           |
| `/admin/schedules`            | Regular hours, time off, extra hours, Calendar-sync navigation            |
| `/admin/integrations`         | Square team-attribution readiness/enforcement and Calendar navigation     |
| `/admin/audit`                | Audited admin configuration changes                                       |

Configuration ownership and role/resource permissions are documented in `docs/booking-operations-dashboard.md`.

## Routine checks

Run these checks for staging promotion, a production launch window, and after changes to offerings, schedules, Calendar connections, Square credentials, or payment code.

### Environment and infrastructure

- [ ] `DATABASE_URL` resolves to the intended migrated private database; `npm run db:check -- --env-file <protected-env-file>` passes.
- [ ] `SERVICE_BOOKING_MODEL_MODE=operational` in the current deployment.
- [ ] Auth.js identity and Calendar OAuth use separate clients and environment-specific redirect URIs.
- [ ] `BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY` is the protected key that encrypted current connection credentials.
- [ ] `KV_REST_API_URL` and `KV_REST_API_TOKEN` reach the intended Upstash instance.
- [ ] `SERVICE_BOOKING_SQUARE_ENABLED=true` and `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true` only where new direct payment should be available.
- [ ] Square environment, access token, application ID, location, webhook key, and URLs belong to the same target application/environment.
- [ ] `PAYMENT_GATEWAY_MODE` is not `mock` in production.
- [ ] `PAYMENT_RECONCILIATION_CRON_SECRET` is configured; `CRON_SECRET` authorizes the scheduled invocation; `/api/admin/payment-reconciliation` remains scheduled every 30 minutes in `vercel.json`.
- [ ] `BOOKING_ADMIN_PAYMENT_ACTION_SECRET` is distinct and protected for no-show actions.
- [ ] Resend transactional and webhook/segment settings are configured for the target environment.
- [ ] `npm run check:square-card-on-file-env` passes with the target variables loaded.

### Admin readiness

- [ ] `/admin/setup` reports no blocker for each provider being offered.
- [ ] Each active provider/resource, service, offering, add-on, price/timing snapshot, and required secondary resource is correct.
- [ ] Weekly schedules and current exceptions are correct in the business timezone.
- [ ] Each active provider primary resource has one healthy canonical booking destination; any intended busy-only assignments on primary or secondary resources are healthy.
- [ ] Each provider has the correct active Square team-member mapping.
- [ ] No connection shows `reconnect_required`, failed Calendar discovery, or unresolved ownership/assignment conflict.

### Customer smoke

- [ ] `/booking` redirects to `/services`; a valid legacy slug alias redirects to its canonical `/services/[slug]/booking` route.
- [ ] `/services` reflects the operational PostgreSQL catalog, not retired Sanity booking fields.
- [ ] Availability excludes schedule closures, active reservations, and Google busy time for all required resources.
- [ ] A hold returns an opaque payment URL and sends no contact/payment/policy fields before the payment step.
- [ ] Square Sandbox tokenization uses `CHARGE_AND_STORE` and confirmation calls `/api/booking/payment/confirm`.
- [ ] The payment result is captured and creates one PostgreSQL appointment plus one Google event, or an explicit manual-follow-up record.
- [ ] Duplicate submit/webhook/reconciliation calls do not create a second charge, card, no-show record, appointment, or Calendar event.
- [ ] With the card-on-file flag disabled, the new payment UI fails closed and does not create a Payment Link.
- [ ] A paid training token exposes only the matching training Appointment Schedule; invalid variants expose no URL.

## Public abuse controls

Booking rate keys contain one-way digests rather than raw client IPs or offering identifiers.

| Control                                |                                                         Current limit | Failure response         |
| -------------------------------------- | --------------------------------------------------------------------: | ------------------------ |
| `GET`/`POST /api/booking/availability` |         30 attempts per rolling 60 seconds per client across services | `429` plus `Retry-After` |
| `POST /api/booking/holds` attempts     |          5 attempts per rolling 10 minutes per client across services | `429` plus `Retry-After` |
| Active holds                           |        2 concurrent ten-minute leases per client and offering/service | `429` plus `Retry-After` |
| Promotion-code attempts                | 10 attempts per rolling 60 seconds per client across payment sessions | `429` plus `Retry-After` |

Vercel Preview/Production trusts only the first valid address in `x-vercel-forwarded-for`. Missing trusted client identity fails availability/holds closed with `503`; it does not accept attacker-supplied forwarding fallbacks. Local development may use `x-forwarded-for` or `x-real-ip`.

Upstash failures fail availability/hold/promotion controls closed with `503`. Do not disable or widen a limiter to work around an outage.

Request bounds are enforced before booking work:

- Availability POST JSON: 8 KiB.
- Hold POST JSON: 24 KiB.
- At most 20 intake answers.
- Question identifier: 128 characters.
- Individual answer: 2,000 characters.
- Combined question/answer UTF-8 data: 8 KiB.

Oversized requests return `413`; invalid structure returns `400`.

## Reconciliation watchlist

Review the scheduled `/api/admin/payment-reconciliation` result and `/admin/booking-issues`. `ok: false` or any error-severity finding requires triage.

High-priority categories include:

- `authorized_payment_pending_capture` and provider state/evidence mismatches.
- `captured_payment_without_operational_appointment` or `provider_completed_payment_without_operational_appointment`.
- `operational_appointment_without_captured_payment`.
- `operational_appointment_calendar_pending_too_long`.
- `payment_amount_currency_customer_mismatch`.
- Booked appointments missing saved-payment-method, policy-acceptance, or no-show records.
- No-show charges pending too long, failed without alerting, or invoice payment events not reconciled.
- Historical `paid_booking_not_booked` or Square payment pending too long.

The reconciliation run also retries eligible booking-outcome emails. Persistent email retry failures do not reverse a durable appointment/payment; investigate delivery separately.

### Triage order for an ambiguous Square result

1. Stop the customer/operator from submitting a changed source or new idempotency key.
2. Read local payment attempt, request-intent, capture-lease, hold/reservation, appointment, and webhook-observation state.
3. Query Square by the stored payment/idempotency/reference evidence.
4. Verify amount, currency, customer, card, reference, and team attribution before accepting provider completion.
5. If Square is `COMPLETED`, persist completion and resume appointment/Calendar projection without a second charge.
6. If Square is terminally failed/cancelled, persist that terminal state and release/fail the hold safely.
7. If provider state remains unknowable, retain manual follow-up. Do not convert uncertainty into a new charge.

## No-show procedure

Use this only for a direct booking with eligible stored policy/card/no-show evidence.

1. Confirm the appointment end time is in the past and staff have recorded attendance as a no-show under the business policy.
2. Read the stored allowed charge amount; do not calculate or guess it from public service copy.
3. Choose one unique idempotency key for the action and retain it for every retry.
4. Submit the authorized action with the exact contract:

   ```json
   {
     "amountCents": 12345,
     "confirmPolicyCharge": true,
     "idempotencyKey": "<unique-stable-key>",
     "operatorId": "<operator-alias>",
     "reason": "<concise-auditable-reason>"
   }
   ```

5. The bearer credential is `BOOKING_ADMIN_PAYMENT_ACTION_SECRET`. Never paste it into evidence or chat.
6. If the response reports a pending or manual-follow-up state, keep the same idempotency key and wait for webhook/reconciliation. Do not submit a different key.
7. Confirm Square/local amount, invoice/payment identity, event processing, and the final no-show state.

The route rejects appointments that have not ended, unconfirmed policy actions, unsafe/non-positive amounts, and amounts that differ from `allowedAmountCents`.

## Troubleshooting

### `/booking` does not render a catalog

This is expected: it is a permanent compatibility redirect. A request without a query, and the exact legacy `?type=in-person-appointment` query, redirect to `/services`. A single accepted legacy service/offering slug redirects to the canonical service booking page only if the slug is operationally bookable. Unknown, empty-valued, conflicting, repeated, or extra query parameters return not found by design.

Check `/services`, `/admin/setup`, and the operational service/offering status instead of Sanity `bookingSettings`.

### Service is absent or no slots appear

Check in this order:

1. `/admin/setup` readiness blockers.
2. Provider/resource, service, offering, public title/summary/slug, add-on, and Square team status.
3. Primary and required secondary resource weekly schedules/effective dates.
4. Time-off/extra-hour exceptions and business timezone.
5. Active reservations/holds for the occupied interval, including buffers/add-on duration.
6. Calendar connection status, canonical assignments, access roles, and busy events.
7. Booking notice/horizon/interval settings.

A missing required resource or schedule, or a missing provider primary-resource destination/credential, is a fail-closed configuration problem; do not bypass it with a browser-supplied identifier. Secondary room/equipment resources need schedules and may have busy-only Calendar assignments, but they do not require a booking destination.

### Calendar OAuth/discovery fails

- Confirm `GOOGLE_REDIRECT_URI` exactly matches the environment OAuth client.
- Confirm Calendar OAuth and Auth.js use the intended separate client variables.
- Confirm Upstash is available for the ten-minute single-use state.
- Restart consent from `/admin/calendar-connections` or `/admin/my-calendar`; do not use the legacy secret URL.
- Reconnect if Google did not return offline access or the connection is `reconnect_required`.
- Resolve duplicate account ownership through the audited transfer controls.
- Restore the correct `BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY` if stored credentials cannot decrypt.

### Calendar reads work but appointment creation fails

A busy-only assignment may have free/busy access, but the booking destination needs Google `writer` or `owner` access. Confirm the active destination, connection, canonical Calendar ID, and access role. If payment is already captured, leave the appointment in manual follow-up and repair/reconcile projection; do not charge again.

### Square card form is missing

`GET /api/booking/square/config` returns unavailable when the card-on-file flag, service flag, Square environment values, application/location ID, or required `DATABASE_URL` setting is missing. It does not test database reachability; connectivity failures surface later when the payment session or confirmation reads/writes PostgreSQL. Confirm environment scoping and run `npm run check:square-card-on-file-env`. The intended public behavior is fail-closed; there is no automatic hosted fallback.

### `/api/booking/payment/confirm` fails

- `400`: invalid request/policy/payment data.
- `402`: provider-declined payment.
- `409`: expired/unavailable hold or changed reservation.
- `502`: Square API/card/invoice failure with no successful outcome reported.
- `503`: infrastructure or ambiguous provider state requiring retry/reconciliation.
- `404`: service Square confirmation is disabled.

Before retrying a `502`/`503`, inspect local intent and Square state. Preserve the original request/idempotency semantics.

### Square webhook returns `401`

Confirm the exact subscription URL and `SQUARE_SERVICE_BOOKING_WEBHOOK_URL`, then the signature key from that same subscription/environment. Square signs `notification URL + raw body`; proxies/domains cannot be treated as equivalent. Do not accept an invalid signature to restore delivery.

### Captured payment has no appointment/event

Treat this as paid reconciliation, not an unpaid retry. Check the captured attempt, appointment finalization state, reservations, provider/resource snapshots, Calendar connection, and reconciliation findings. Resume idempotent finalization or move to rebooking-first manual handling. Refund only after provider confirmation and an authorized business decision.

### Transactional email is missing

Check the durable appointment/order/enrollment outcome first. Then inspect the retry state, Resend credentials/domain, template configuration, and the reconciliation/customer-email workers. Do not recreate a booking or payment to resend email.

### Training schedule is unavailable

Check the paid enrollment, token hash/status, 14-day expiry, exact program slug, published Sanity Appointment Schedule URL, and URL validation. Rendering does not mark scheduled. Do not bypass the token gate by sending the raw Google URL.

## Stop conditions and emergency controls

Stop new service card collection by setting:

```env
SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=false
```

Keep `SERVICE_BOOKING_SQUARE_ENABLED=true`, Square credentials, webhook verification, and reconciliation secrets active so in-flight direct payments, refunds/no-show actions, and historical hosted records remain recoverable.

Disable affected providers/offerings in the admin dashboard when Calendar/resource readiness is unsafe. Do not delete connections, assignments, payment rows, or appointments to hide an incident.

Stop promotion or public booking if any of these are true:

- Private DB migration lineage does not pass `npm run db:check`.
- Square credentials/location/team mappings are mixed across environments.
- Webhook test events repeatedly fail signature verification or retryable failures cannot persist.
- A duplicate charge, appointment, reservation transfer, saved card, or Calendar event is observed.
- Captured/completed provider payments lack a durable local attempt/appointment and are not contained in manual follow-up.
- An appointment exists without captured-payment evidence.
- Calendar credentials cannot decrypt or active destinations cannot be discovered/written.
- Reconciliation reports unresolved provider evidence, amount/currency/customer/card/team mismatch, or stale capture/no-show state.
- PII, raw tokens, credentials, payment-session references, or private event bodies appear in Sanity, logs, tickets, or release evidence.

## Incident evidence

Record only:

- Environment and deployment identifier.
- UTC timestamps.
- Redacted internal hold/order/appointment reference.
- Route and HTTP status.
- State-machine status and reconciliation category.
- Whether Square/Calendar/Resend lookup succeeded, without raw payloads.
- Operator alias and approved recovery action.

Never record database URLs, OAuth setup URLs/state/codes, encryption keys, Square access/source/verification tokens, webhook secrets/bodies, customer PII, or full provider identifiers.

## Private database changes and recovery

Migrations are forward-only and tracked by the complete `drizzle/meta/_journal.json` lineage. Do not use an old booking migration filename list to decide whether an environment is current.

Follow `docs/private-database-migration-runbook.md` for preflight, backups, apply/check commands, production approval, and roll-forward recovery. Never edit/delete payment, hold, reservation, appointment, Calendar credential, or migration-history rows as ad hoc incident repair.

Safe recovery principles:

- Persist external provider completion before local projection.
- Retry idempotently from durable state.
- Rebook before refund when a paid slot cannot be projected.
- Preserve historical/handoff compatibility long enough to finish existing records, but do not send new customers into retired flows.
- Keep transactional email and Calendar side effects subordinate to the PostgreSQL outcome.
- Prefer an explicit manual-follow-up state over assuming success or failure.

Related current setup references:

- `docs/booking-system-setup-guide.md`
- `docs/booking-operations-dashboard.md`
- `docs/google-calendar-oauth-env-setup.md`
- `docs/booking-training-calendar-configuration-guide.md`
- `docs/square-service-booking-setup.md`
- `docs/private-database-migration-runbook.md`
- `docs/launch-readiness-checklist.md`
