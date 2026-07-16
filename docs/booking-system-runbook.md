# Booking System Runbook

Last updated: 2026-07-15

Use this runbook when operating, smoke testing, or troubleshooting Lash Her booking flows in staging or production. It assumes the provider split is live: service booking customers select slots in the Lash Her app, enter contact and payment data only on an opaque payment-session page, and use Square direct charge-and-store before the authoritative PostgreSQL appointment is projected to Google Calendar. Product checkout and training checkout remain on Helcim by default. Historical Square hosted-checkout records remain reconcilable, but disabling direct card-on-file payment now fails new payment sessions closed instead of creating a new hosted checkout. Training checkout may optionally use a Square Afterpay Invoice when `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`; see `docs/training-afterpay-square-invoice.md` for the launch gate and operational rules.

## System Boundaries

| System                      | Operator responsibility                                                                                                                                                                                                   | Must not become                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sanity                      | Public booking copy, booking settings, bookable services, native payment fields, cache revalidation                                                                                                                       | Storage for PII, payment state, holds, booking history, or transaction records                                                                         |
| Private Postgres            | Holds, checkout orders, payment events, appointment state, training enrollments, reconciliation data                                                                                                                      | Public CMS or browser-readable data source                                                                                                             |
| Upstash Redis               | Short-lived contention locks, public booking rate windows, and expiring active-hold quotas                                                                                                                                | Canonical payment, booking, identity, or Calendar credential storage                                                                                   |
| Google Calendar API         | Staff source of truth for final service booking events and busy intervals                                                                                                                                                 | Payment gate or Appointment Schedule engine                                                                                                            |
| Google Appointment Schedule | Paid training intro-call scheduling after private token eligibility passes                                                                                                                                                | Service booking engine or paid-status verifier                                                                                                         |
| Square                      | Direct service payment/card storage, historical hosted-checkout reconciliation, payment webhooks, and optional training Afterpay invoices                                                                                 | Product checkout, default training checkout, or sole proof of booking success                                                                          |
| Helcim                      | Product checkout and default training checkout initialization, payment approval, webhook event source                                                                                                                     | New service booking payment provider, sole authority for final booking state, or training checkout when the optional Square invoice feature is enabled |
| Resend                      | Customer/admin transactional emails                                                                                                                                                                                       | Source of truth for booking success                                                                                                                    |

If a record contains customer contact data, payment identifiers, hold state, or reconciliation metadata, treat it as private Postgres data. Do not move it into Sanity.

## Live Flows

### Public Booking Entry

1. Customer opens `/booking`.
2. The page loads Sanity `bookingSettings` and active `service` records.
3. The browser requests availability from `/api/booking/availability`.
4. The server builds slots from configured availability marker events, Google Calendar busy intervals, private active holds, lead time, horizon, duration, intervals, and buffers.
5. Appointment confirmation does not happen from `/api/booking/create`; that route is intentionally disabled and returns the secure-payment-required error.
6. Paid service booking continues through resource-backed private hold creation, opaque payment handoff, explicit policy acceptance, Square charge-and-store, durable appointment creation, and Calendar projection. Disabling direct payment fails the payment step closed.
7. Paid training intro-call scheduling uses the tokenized training schedule page and Google Appointment Schedule after private token eligibility passes.

### Paid Service Booking With Capture Lease, Policy Acceptance, And Card On File

1. Customer selects a paid bookable service and slot.
2. `/api/booking/holds` revalidates the slot, reserves every required resource, creates a private hold, and returns only an opaque payment-session URL. Contact, policy, and payment fields are rejected at this step.
3. When `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true` and `/api/booking/square/config` is available:
   - The payment page collects customer details, payment amount selection, marketing choice, and explicit no-show policy acceptance.
   - The browser loads the Square Web Payments SDK, tokenizes with `verificationDetails.intent = "CHARGE_AND_STORE"`, and submits the token, verification token, and a fresh client idempotency key to `POST /api/booking/payment/confirm`.
   - Before calling Square, the server atomically acquires a capture lease over the hold/reservations and persists a hashed provider-request intent. Reservation expiry excludes a valid lease and durable authorized/captured attempts.
   - A same-body retry reuses the persisted provider idempotency key. A changed source first invokes Square cancel-by-idempotency-key, records the old intent terminally, and uses a new key. An ambiguous create-payment response remains reconciliation work and is never treated as permission for a changed retry under the old key.
   - The server revalidates the lease and reservation set immediately before capture. Provider `COMPLETED` evidence is persisted before appointment projection; a retry resumes projection without another Square charge.
   - The finalizer creates one authoritative appointment, transfers the resource reservations, creates or finds the Google Calendar event idempotently, and links saved-card, policy, no-show, payment, provider, resource, and employee-attribution snapshots.
4. When direct card-on-file payment or its public config is disabled, the payment page fails closed. Existing hosted-checkout return/webhook records remain supported for historical reconciliation, but the UI does not create new Payment Links. Treat the flag as an emergency stop, not a continuity fallback.
5. Customer and admin transactional emails are sent non-blockingly after the private state transition.

Duplicate submissions, browser restarts, return visits, and webhook events must resolve to one provider request intent, one captured payment, one saved card, one policy acceptance, one no-show charge record, one appointment, and one Google Calendar event. If the provider completed but local projection is incomplete, reconciliation verifies amount, currency, customer, reference, and team attribution before resuming. If the original slot cannot be projected, keep the appointment in manual/rebooking follow-up; refund only after rebooking fails or staff chooses refund.

### Paid Training Intro Call

Default path (Helcim):

1. Training checkout completes through the commerce checkout flow.
2. Helcim verifies the payment for the training order.
3. The private training enrollment/order is marked paid and a private schedule token is issued.
4. The customer receives the tokenized paid training schedule path.
5. The app resolves private token eligibility before rendering anything that exposes the Google Appointment Schedule URL.
6. After eligibility passes, the page shows the public Google Appointment Schedule link or embed configured on the training program.
7. The app does not mark the enrollment scheduled only because the schedule page rendered. Invalid, unpaid, expired, or wrong-program tokens must not reveal the schedule URL.

Optional Square Afterpay Invoice path (when `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`):

1. Training checkout completes through the commerce checkout flow.
2. The app creates and publishes a Square invoice for the training order.
3. Square webhook `invoice.payment_made` is verified through `/api/webhooks/square` and the training enrollment/order is marked paid in the private DB.
4. Steps 4-7 above follow.

The Square webhook route is shared with service booking; training invoice events must be routed to the training Square Invoice finalizer before falling back to service-booking or no-show reconciliation. See `docs/training-afterpay-square-invoice.md` for the feature flag, launch gate, webhook events, and recovery steps.

Google Appointment Schedule is only for paid training intro-call scheduling after the app token gate. Do not use it for service bookings.

## Public Booking Abuse Controls

The shared V1/V2 availability and hold endpoints use atomic Upstash Redis sorted-set scripts. Availability and hold-attempt windows are global per one-way client-IP digest, so rotating arbitrary service or offering identifiers cannot create fresh buckets or unbounded Redis keys. The active-hold quota additionally includes a one-way offering ID or service-slug digest. Raw IP addresses are never written into rate-limit keys or application logs.

| Endpoint/control | Limit | Response when exceeded |
| --- | ---: | --- |
| `GET` or `POST /api/booking/availability` | 30 requests per rolling 60 seconds for each client IP across all service/offering identifiers | `429` with `Retry-After` |
| `POST /api/booking/holds` attempt window | 5 requests per rolling 10 minutes for each client IP across all service/offering identifiers | `429` with `Retry-After` |
| Active hold quota | 2 concurrent 10-minute hold leases for each client IP and offering/service | `429` with `Retry-After` based on the earliest lease expiry |

Vercel launch environments accept client identity only from `x-vercel-forwarded-for`. If that trusted header is missing or malformed, the endpoints return `503`; they do not fall back to a shared unknown-client bucket or client-supplied forwarding headers. Local and test environments retain the existing `x-forwarded-for`, then `x-real-ip`, fallback for development only.

Limiter storage is fail-safe: hold creation returns `503` before booking work when Upstash cannot be read or written, and availability returns `503` before Sanity/Postgres/Google Calendar fan-out. A failed or conflicting hold creation releases its active-hold lease; a successful hold retains the lease until the normal ten-minute expiry. A release failure is conservatively safe because the lease expires automatically.

Request bounds are applied before booking processing:

- Availability POST JSON: 8 KiB maximum.
- Hold POST JSON: 24 KiB maximum.
- Hold intake answers: at most 20 entries.
- Intake question identifier: at most 128 characters.
- Individual intake answer: at most 2,000 characters.
- Combined UTF-8 size of question identifiers and answers: 8 KiB maximum.

Oversized requests return `413`; structurally invalid answer lists return `400`. Do not raise these limits to address ordinary customer errors. Investigate the client payload first.

## Routine Operator Checks

Run these checks for staging release validation, production launch windows, and after changes to booking settings, payment, or calendar configuration.

### Environment Checks

- [ ] `NEXT_PUBLIC_SANITY_PROJECT_ID` is `3auncj84`.
- [ ] `NEXT_PUBLIC_SANITY_DATASET` matches the target environment.
- [ ] `SANITY_WEBHOOK_SECRET` matches the Sanity webhook panel.
- [ ] `DATABASE_URL` points to the intended private database and is server-only.
- [ ] `KV_REST_API_URL` and `KV_REST_API_TOKEN` point to the intended Upstash Redis instance.
- [ ] `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` match the environment OAuth client.
- [ ] `BOOKING_ADMIN_SETUP_SECRET` is configured for the protected Google Calendar OAuth setup flow and stored server-only.
- [ ] `HELCIM_GENERAL_API_TOKEN`, `HELCIM_TRANSACTION_API_TOKEN`, and `HELCIM_WEBHOOK_VERIFIER_TOKEN` are configured.
- [ ] `CHECKOUT_SECRET_ENCRYPTION_KEY` is configured as a base64-encoded 32-byte server-only secret.
- [ ] `SERVICE_BOOKING_SQUARE_ENABLED=true` only where service booking checkout should use Square.
- [ ] `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true` only where direct charge-and-store should accept new payment sessions; unset or `false` is an emergency fail-closed stop and does not create new hosted checkouts.
- [ ] `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true` only when the optional training Afterpay Square Invoice flow should be active; leave unset or `false` to keep default Helcim training checkout. Confirm Square merchant eligibility before enabling in production.
- [ ] If `SERVICE_BOOKING_SQUARE_ENABLED=true`, the code-required Square environment values are configured as server-side variables: `SQUARE_ENVIRONMENT`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_SERVICE_BOOKING_RETURN_URL`, and `SQUARE_SERVICE_BOOKING_WEBHOOK_URL`.
- [ ] If `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true`, the public-safe `SQUARE_APPLICATION_ID` is also configured for the Square Web Payments SDK config route. `SQUARE_APPLICATION_ID` is not a secret and must not be treated as one.
- [ ] If `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`, the code-required Square environment values are configured as server-side variables: `SQUARE_ENVIRONMENT`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, and `SQUARE_SERVICE_BOOKING_WEBHOOK_URL`. Training Square Invoice alone does not require `SQUARE_SERVICE_BOOKING_RETURN_URL` or `SQUARE_APPLICATION_ID`.
- [ ] `PAYMENT_RECONCILIATION_CRON_SECRET` is required to enable and manually protect `GET /api/admin/payment-reconciliation`; `CRON_SECRET` is accepted for Vercel scheduled cron authorization only when `PAYMENT_RECONCILIATION_CRON_SECRET` is also configured. Both are stored server-only.
- [ ] Confirm the payment-reconciliation cron remains scheduled every 30 minutes. Its payment monitor and booking-outcome email retry are isolated so either task can run and report failure without suppressing the other.
- [ ] `BOOKING_ADMIN_PAYMENT_ACTION_SECRET` is configured for `POST /api/admin/appointments/[id]/no-show` and stored server-only.
- [ ] `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_SEGMENT_MARKETING_ID`, `FROM_EMAIL`, and `ADMIN_EMAIL` are configured.

### Public Booking Entry Smoke

- [ ] Open `/booking` on the target environment and confirm the page renders.
- [ ] Confirm active bookable services appear in the intended order.
- [ ] Confirm appointment availability loads from the connected calendar.
- [ ] Confirm direct `/api/booking/create` requests reject with the secure-payment-required error.
- [ ] Confirm the booking marketing opt-in and no-opt-in paths create private audit evidence and do not create Sanity submission documents.
- [ ] Confirm repeated availability requests eventually return `429` with an integer `Retry-After` header and do not call Google Calendar after the limit is reached.
- [ ] Confirm the sixth hold attempt for one test client/service within ten minutes returns `429`, and a third concurrent active hold returns `429` until the earliest hold expires.
- [ ] Confirm oversized availability and hold JSON return `413` before booking dependencies are called.
- [ ] Confirm production requests missing `x-vercel-forwarded-for` fail closed with `503`; never record or paste the raw test IP in evidence.

### Paid Service Booking Smoke

- [ ] Create a paid service booking hold in staging with test data.
- [ ] When card-on-file is enabled, confirm the policy checkbox blocks submission until accepted.
- [ ] Confirm the slot flow returns an opaque payment-session URL and does not accept contact or payment fields.
- [ ] Complete Square sandbox `CHARGE_AND_STORE` tokenization; confirm the private hold transitions to `booked`.
- [ ] When card-on-file is enabled, confirm the booked hold has a saved Square card reference, a policy acceptance record, a no-show charge record, and one Google Calendar event.
- [ ] When card-on-file is enabled, simulate a card-save failure and confirm the hold is not marked booked and no Calendar event is created.
- [ ] Simulate connection loss after Square accepts `CreatePayment`; confirm the request intent and capture lease remain durable and the same-body retry uses the same idempotency key.
- [ ] Submit a changed source after an ambiguous attempt; confirm cancel-by-idempotency-key is recorded before a new provider key is used.
- [ ] Deliver `payment.updated` before the original response; confirm the observer correlates it to the immutable request intent without creating an appointment twice.
- [ ] For historical hosted-checkout records only, confirm a Square browser return without server-side paid reconciliation does not finalize booking.
- [ ] Confirm the private hold transitions to booked or `paid_unbookable_rebooking_pending`.
- [ ] Confirm one Google Calendar event exists for the selected slot.
- [ ] Confirm Square webhook and reconciliation retries are idempotent and verify amount, currency, customer, reference, and team member before projection.

### No-Show Charge Procedure

Service bookings that completed the card-on-file confirmation flow can be marked no-show through `POST /api/admin/appointments/[id]/no-show` with a valid `BOOKING_ADMIN_PAYMENT_ACTION_SECRET` bearer token. The route attempts to charge the saved card only after staff authorization and appointment eligibility are proven.

Before submitting a no-show charge, staff must confirm the appointment end time has passed, enter their operator identifier, and record a concise reason. The system stores `admin_operator_id`, `admin_reason`, `admin_action_at`, and `admin_eligibility_checked_at` before calling Square. If any of these fields are missing, do not retry the charge; correct the admin request first. Requests are rejected with `NO_SHOW_APPOINTMENT_NOT_ENDED` until the appointment's `selectedEnd` is in the past.

Operational guidance:

- The audit write uses compare-and-set semantics, so replays or concurrent requests will not overwrite an existing admin action. If a response is ambiguous, inspect the no-show charge record for the four audit fields before retrying.
- If Square is disabled in the environment, the route still records the admin audit and returns `manual_followup` so the action is attributed to the operator.
- Treat `charge_failed` and `manual_followup` results as requiring manual review. Do not silently retry with a different idempotency key when money may have moved or provider references exist; preserve the existing idempotency key and webhook/event evidence and escalate.
- A `charge_pending` result means Square did not return a terminal status; await webhook reconciliation or review the Square dashboard before submitting another charge.

### Card-On-File No-Show Smoke

Run these in the order defined in `docs/square-service-booking-setup.md` under **Card-on-file staging certification order**. Before the sequence, run the preflight script `npm run check:square-card-on-file-env` and record evidence in `docs/superpowers/reports/square-card-on-file-sandbox-certification.md`.

- [ ] Create a paid service booking hold and complete the card-on-file confirmation flow in sandbox.
- [ ] Confirm the route rejects requests until the appointment end time has passed and requires a valid operator identifier and reason.
- [ ] Call `POST /api/admin/appointments/[id]/no-show` with a valid `BOOKING_ADMIN_PAYMENT_ACTION_SECRET` bearer token and a request body of `{ amountCents: <appointment-max-charge-cents>, confirmPolicyCharge: true, idempotencyKey: "<unique-key>", operatorId: "<operator-alias>", reason: "<concise-reason>" }`. Confirm the amount equals the appointment max charge and the no-show charge succeeds against the saved sandbox card.
- [ ] Confirm the no-show charge record stores `admin_operator_id`, `admin_reason`, `admin_action_at`, and `admin_eligibility_checked_at` before Square is called.
- [ ] Simulate a declined no-show charge and confirm the local no-show charge record enters `charge_failed` state and emits an operational alert.

### Paid Training Smoke

Default Helcim path:

- [ ] Complete a paid training checkout in staging.
- [ ] Confirm Helcim payment marks the private enrollment/order paid.
- [ ] Confirm the customer receives the tokenized paid training schedule link.
- [ ] Confirm invalid, unpaid, expired, or wrong-program tokens do not reveal the Google Appointment Schedule URL.
- [ ] Confirm a valid token renders the Google Appointment Schedule link or embed.
- [ ] Confirm rendering the page does not mark the private enrollment scheduled.

Optional Square Afterpay Invoice path (when `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`):

- [ ] Complete a training checkout that creates and publishes a Square invoice in staging.
- [ ] Confirm `invoice.payment_made` reaches `/api/webhooks/square` and is routed to the training Square Invoice finalizer before service-booking or no-show fallback handling.
- [ ] Confirm the private enrollment/order is marked paid, exactly one training enrollment is created, and the customer receives the tokenized paid training schedule link.
- [ ] Confirm retried webhook delivery is idempotent and does not duplicate enrollment, scheduling token, payment event, or notification side effects.
- [ ] Confirm non-finalizing invoice events do not finalize enrollment.

See `docs/training-afterpay-square-invoice.md` for the launch gate, required Square dashboard configuration, and recovery steps.

### Sanity Revalidation Smoke

- [ ] Publish a small `bookingSettings` edit in the target Studio.
- [ ] Confirm `/api/revalidate` receives a signed webhook with projection `{ _type }`.
- [ ] Confirm the `bookingSettings` cache tag is expired and `/booking` updates.
- [ ] Publish or update one `service` record and confirm `/booking` reflects the change.

## Direct-payment emergency stop and booking-model rollback

Set `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=false` and redeploy to stop new direct payment confirmations. New payment sessions fail closed; they do not fall back to a hosted checkout. Existing holds expire normally, while captured/authorized attempts, confirmed bookings, saved cards, and no-show records remain in private Postgres for reconciliation and staff follow-up.

To stop creation of new V2 operational holds while keeping existing V1/V2 records recoverable, set `SERVICE_BOOKING_MODEL_MODE=legacy` and redeploy. This does not reverse schema migrations and does not erase operational records. Do not delete Square cards, provider intents, payment attempts, appointments, or Calendar correlations during rollback.

## Reconciliation Watchlist

At launch and after payment/calendar incidents, inspect private operational state for:

- Active service `held` holds past expiry.
- `payment_pending` holds older than the configured payment-success grace window.
- Paid service orders without Google Calendar event IDs.
- Expired holds that later received payment success.
- Orders or holds marked `booking_failed`, `manual_followup`, or `paid_unbookable_rebooking_pending`.
- Booked service holds missing `savedPaymentMethodId`, `policyAcceptanceId`, or `noShowChargeRecordId`.
- No-show charge records in `charge_failed` that have not been alerted or manually reviewed.
- No-show charge records missing `admin_operator_id`, `admin_reason`, `admin_action_at`, or `admin_eligibility_checked_at`.
- Square webhook events that do not match a known private service order, no-show charge record, or training Square Invoice order.
- Helcim webhook events that do not match a known product or default training order.
- Duplicate webhook/idempotency keys.
- Authorized local attempts for which Square reports `COMPLETED`, especially when no appointment exists.
- Provider payment evidence whose amount, currency, customer, reference, or team member differs from the immutable local intent.
- Pending legacy Square Payment Link orders that have not reconciled within the grace window.
- Paid training enrollments without schedule-token progress.
- Paid training schedule tokens that cannot pass eligibility.
- Calendar events created without a matching private booking record.

Evidence must be redacted. Do not paste customer emails, phone numbers, raw webhook bodies, full connection strings, payment tokens, or complete transaction identifiers into tickets or release notes.

## Troubleshooting

### `/booking` Does Not Load

Check:

- Sanity public env vars and dataset target.
- `bookingSettings` singleton exists and is published.
- At least one active bookable `service` exists for the expected booking type.
- Sanity webhook/revalidation logs if the content was just published.
- Vercel logs for loader or env validation errors.

Operator action:

1. Verify the target Studio and dataset first.
2. Republish `bookingSettings` if the page is stale.
3. If stale content remains after a successful signed webhook, compare cache tag handling in `/api/revalidate` and `src/data/loaders.ts` before changing content again.

### Slots Are Missing Or Incorrect

Check:

- Google OAuth is connected for the target environment.
- `bookingSettings.calendarId` matches the connected calendar.
- The connected Google account can read and write events on that calendar.
- Availability marker events use the configured marker title.
- Booking horizon, minimum lead time, duration, interval, and buffers are intentional.
- Existing private holds or Calendar events are blocking the slot.
- Upstash Redis is reachable for abuse controls and short-lived contention locks.

Operator action:

1. Confirm Google Calendar contains the expected availability marker events.
2. Confirm private active holds are not stale.
3. If OAuth is broken, rerun the protected OAuth setup flow for the target environment.

### Google OAuth Or Calendar Insert Fails

Check:

- `GOOGLE_REDIRECT_URI` exactly matches the OAuth client redirect URI.
- `KV_REST_API_URL` and `KV_REST_API_TOKEN` point to the same Redis instance used during setup.
- The Google Calendar API is enabled in the Google Cloud project.
- The calendar owner account approved the Calendar Events scope.
- The encrypted OAuth credential still exists in the private Calendar connection and its credential owner is correct.

Operator action:

1. Do not change the calendar ID blindly.
2. Reconnect OAuth using the documented internal OAuth setup process with the admin setup secret from the secure secret manager.
3. Rotate `BOOKING_ADMIN_SETUP_SECRET` if the admin setup secret may have been exposed.

### Hold Is Expired, Payment Pending, Or Manual Follow-Up

Check:

- Hold state and expiry timestamp in private Postgres.
- Checkout order status and provider references.
- Square order/payment references for service bookings, or Helcim invoice/payment references for product and default training checkout, or Square invoice/payment references for training when `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`.
- Square webhook delivery logs for service bookings and (when enabled) training Square Invoice orders, or Helcim webhook delivery logs for product and default training checkout.
- Whether a Calendar event already exists for the hold metadata.

Operator action:

1. If payment did not succeed, release or let the hold expire and ask the customer to retry.
2. If service payment succeeded but the slot is no longer available, keep the record in `paid_unbookable_rebooking_pending`, offer a new slot first, verify replacement availability before Calendar event creation, and refund only after rebooking fails or staff chooses refund.
3. If Calendar insertion may have succeeded but the response was lost, search for the existing event before creating anything manually.

### Availability Or Holds Return 429 Or 503

Check:

- `Retry-After` on a `429` response before asking the customer to retry.
- Upstash availability, latency, and command errors for `503` responses.
- `KV_REST_API_URL` and `KV_REST_API_TOKEN` point to the intended environment.
- Vercel is supplying a valid `x-vercel-forwarded-for` header in preview/production.
- The browser is not polling availability repeatedly because of a client retry loop.

Operator action:

1. For `429`, wait for `Retry-After`; do not bypass or delete Redis keys for one customer.
2. For `503`, verify Upstash and trusted-header delivery before reopening booking traffic. Hold creation intentionally fails closed.
3. Use only hashed limiter-key evidence. Never log, copy into tickets, or expose the raw client IP.
4. Do not disable the limiter to compensate for Google Calendar latency or an application polling bug.

### Square Service Payment Verification Fails

Check:

- Webhook URL exactly matches `SQUARE_SERVICE_BOOKING_WEBHOOK_URL`.
- `SQUARE_WEBHOOK_SIGNATURE_KEY` is scoped to the same Square app and webhook subscription.
- `SQUARE_ENVIRONMENT`, `SQUARE_ACCESS_TOKEN`, and `SQUARE_LOCATION_ID` match the intended Square sandbox or production account.
- Square provider event IDs are recorded in private idempotency rows.

Operator action:

1. Treat browser return as an incomplete handoff until server-side reconciliation proves payment.
2. Use Square dashboard delivery status and Vercel logs to identify failed events.
3. Do not replay events manually unless idempotency evidence is understood.

### Helcim Commerce Webhook Or Payment Verification Fails

Check:

- Webhook URL is `https://<domain>/api/webhooks/card-transactions` and uses HTTPS.
- The URL does not include forbidden provider wording from the Helcim dashboard rules.
- `HELCIM_WEBHOOK_VERIFIER_TOKEN` matches the Helcim dashboard verifier.
- General and transaction API tokens are in the correct environment.
- Private payment-event idempotency rows are being recorded.

Operator action:

1. Use Helcim dashboard delivery status and Vercel logs to identify the failed event.
2. Do not replay the same event manually unless idempotency evidence is understood.
3. If browser validation succeeded but webhook failed, confirm the product or training order already reached the expected private paid state before retrying anything.

### Email Does Not Send

Check:

- `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_SEGMENT_MARKETING_ID`, `FROM_EMAIL`, and `ADMIN_EMAIL` are configured.
- The sender domain is verified in Resend.
- Vercel logs show the email error after the private state transition.
- The 30-minute `/api/admin/payment-reconciliation` cron is running and its booking-outcome retry summary is not reporting persistent failures.

Operator action:

1. Do not roll back a confirmed booking only because email failed.
2. Record the Resend message/error ID with addresses redacted.
3. Check the relevant private DB email state/error field for the product order, training enrollment, or booking hold.
4. For V2 bookings, also inspect `bookingConfirmationEmailOutcome`. A `manual_followup` outcome on an appointment that is now booked remains eligible for one booked correction; missing legacy outcome metadata is not treated as a correction request.
5. Let the scheduled retry reclaim expired claims oldest-first. Do not change either the booked key (`booking-confirmation:<holdId>`) or manual key (`booking-confirmation:<holdId>:manual_followup`) when retrying.
6. Send a manual customer follow-up if the booking, product order, or paid training instruction email still fails after the scheduled retry.
7. Use `docs/resend-transactional-email-setup.md` for Resend sender/domain and environment troubleshooting.

### Customer Cannot Access Paid Training Schedule

Check:

- The token belongs to a paid training enrollment for the requested program.
- The token has not expired or already been revoked.
- The requested training program has a published Google Appointment Schedule URL or embed mode.
- The page is resolving eligibility before rendering the schedule URL.

Operator action:

1. Verify the paid training enrollment in private Postgres.
2. Send the customer a valid paid training schedule link again if policy allows.
3. If the token state is wrong, escalate for a private record correction decision; do not bypass eligibility in Sanity and do not paste the Appointment Schedule URL into public docs or tickets.

## Stop Conditions

Stop the launch or release window if any of these occur:

- Production `DATABASE_URL` cannot be verified as the intended target.
- Production backup/PITR is unavailable before an approved migration window.
- Customer PII, payment state, or booking history appears in Sanity.
- Live booking or form flows create new Sanity submission documents.
- Paid service payment succeeds but the finalizer repeatedly fails to book or mark rebooking/manual follow-up.
- Square service webhook signatures cannot be verified.
- Helcim commerce webhook signatures cannot be verified.
- Google Calendar writes fail for confirmed paid bookings.
- Public booking accepts a retired tokenized handoff.

## Escalation

| Situation                                              | First action                                                                                                                                    | Escalate to                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Booking page stale after publish                       | Verify Sanity webhook delivery, projection, and cache tag                                                                                       | Technical operator                            |
| Service payment succeeded but booking did not finalize | Preserve private records, inspect finalizer logs, check Calendar event existence                                                                | Technical operator and business owner         |
| Customer paid for a service and slot is unavailable    | Keep rebooking pending, offer alternate slot, verify availability before Calendar event, refund only if rebooking fails or staff chooses refund | Business owner                                |
| PII or payment data appears in Sanity                  | Stop affected flows and preserve evidence                                                                                                       | Business/privacy owner and technical operator |
| Production migration concern                           | Stop; follow `docs/private-database-migration-runbook.md`                                                                                       | Migration approver                            |

Nataliea remains the accountable business/privacy owner. Dardan is the contract technical operator/steward while actively engaged. A post-contract operator or vendor must be named before launch for ongoing private-record operations.

## Private Database Migrations

### Forward-only migration and recovery note

The migration journal contains both `0010_familiar_jazinda` and `0010_dry_magneto`, the recovered operational chain `0018` through `0021`, and capture-lease migration `0022_cold_mikhail_rasputin`. Do not rewrite, renumber, or destructively roll back applied migrations. Continue with forward migrations only.

Before deploy, verify backup/PITR, inspect the target `drizzle.__drizzle_migrations` journal, run `npm run db:generate` expecting no drift, and apply with the explicit target/host guards. For an application rollback, deploy the previous code and use `SERVICE_BOOKING_MODEL_MODE=legacy`; leave the additive schema in place. To roll forward again, deploy the recovered code, rerun `npm run db:migrate` idempotently, restore `dual`, and repeat readiness/payment/calendar smoke checks before `operational` cutover.

## Safe Recovery Principles

- Private Postgres is canonical for sensitive booking/payment state.
- Search for an existing Calendar event before creating any manual replacement.
- Preserve idempotency keys and webhook event evidence.
- Prefer manual follow-up over silent retries when money has moved but booking state is uncertain.
- Do not delete or edit private production records casually. If schema changes are needed, use generated migrations and the migration runbook.
- Keep all incident evidence redacted.
