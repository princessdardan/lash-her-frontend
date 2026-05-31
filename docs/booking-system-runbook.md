# Booking System Runbook

Date: 2026-05-23

Use this runbook when operating, smoke testing, or troubleshooting Lash Her booking flows in staging or production. It assumes the provider split is live: service booking customers select slots in the Lash Her app, paid service bookings redirect to Square hosted checkout, product and training checkout remain on Helcim, and verified service bookings create events on the connected Google Calendar through the Google Calendar API.

## System Boundaries

| System | Operator responsibility | Must not become |
| --- | --- | --- |
| Sanity | Public booking copy, booking settings, bookable services, native payment fields, cache revalidation | Storage for PII, payment state, holds, booking history, or transaction records |
| Private Postgres | Holds, checkout orders, payment events, appointment state, training enrollments, reconciliation data | Public CMS or browser-readable data source |
| Upstash Redis | Google Calendar OAuth refresh token, calendar locks, idempotency keys, short-lived contention locks | Canonical payment or booking storage |
| Google Calendar API | Staff source of truth for final service booking events and busy intervals | Payment gate or Appointment Schedule engine |
| Google Appointment Schedule | Paid training intro-call scheduling after private token eligibility passes | Service booking engine or paid-status verifier |
| Square | Hosted checkout, return reconciliation, and webhook payment source for service bookings only | Product checkout, training checkout, or sole proof of booking success |
| Helcim | Product checkout and training checkout initialization, payment approval, webhook event source | New service booking payment provider or sole authority for final booking state |
| Resend | Customer/admin transactional emails | Source of truth for booking success |

If a record contains customer contact data, payment identifiers, hold state, or reconciliation metadata, treat it as private Postgres data. Do not move it into Sanity.

## Live Flows

### Public Booking Entry

1. Customer opens `/booking`.
2. The page loads Sanity `bookingSettings` and active `service` records.
3. The browser requests availability from `/api/booking/availability`.
4. The server builds slots from configured availability marker events, Google Calendar busy intervals, private active holds, lead time, horizon, duration, intervals, and buffers.
5. Appointment confirmation does not happen from `/api/booking/create`; that route is intentionally disabled and returns the secure-payment-required error.
6. Paid service booking continues through private hold creation, Square checkout, server-side payment reconciliation, and final Calendar finalization.
7. Paid training intro-call scheduling uses the tokenized training schedule page and Google Appointment Schedule after private token eligibility passes.

### Paid Service Booking With Hold And Square Payment

1. Customer selects a paid bookable service and slot.
2. `/api/booking/holds` revalidates the slot and creates a private hold with an immutable snapshot of the selected deposit/full/custom-partial payment amount.
3. `/api/booking/checkout` initializes Square hosted checkout from the hold snapshot, creates or updates a pending private order, and marks the hold `payment_pending`.
4. The browser redirects to Square. The Square return URL is not proof of payment.
5. `/api/booking/square/return` and `/api/webhooks/square` reconcile server-side with Square before treating the payment as verified.
6. Verified Square payment moves the service booking into private paid Calendar-pending state, then the shared finalizer locks the order and hold.
7. The finalizer reuses or creates one Google Calendar API event, marks the hold booked, persists payment and Calendar evidence in private DB, and sends emails non-blockingly.

Duplicate return/webhook success should produce one final booking, not duplicate Calendar events. If payment is verified after the original hold expired or conflicts with another event, keep the hold in `paid_unbookable_rebooking_pending`. Staff must try manual rebooking first, verify replacement availability before creating a Calendar event, and refund only after rebooking fails or staff chooses refund.

### Paid Training Intro Call

1. Training checkout completes through the commerce checkout flow.
2. Helcim verifies the payment for the training order.
3. The private training enrollment/order is marked paid and a private schedule token is issued.
4. The customer receives the tokenized paid training schedule path.
5. The app resolves private token eligibility before rendering anything that exposes the Google Appointment Schedule URL.
6. After eligibility passes, the page shows the public Google Appointment Schedule link or embed configured on the training program.
7. The app does not mark the enrollment scheduled only because the schedule page rendered. Invalid, unpaid, expired, or wrong-program tokens must not reveal the schedule URL.

Google Appointment Schedule is only for paid training intro-call scheduling after the app token gate. Do not use it for service bookings.

## Routine Operator Checks

Run these checks for staging release validation, production launch windows, and after changes to booking settings, payment, or calendar configuration.

### Environment Checks

- [ ] `NEXT_PUBLIC_SANITY_PROJECT_ID` is `3auncj84`.
- [ ] `NEXT_PUBLIC_SANITY_DATASET` matches the target environment.
- [ ] `SANITY_WEBHOOK_SECRET` matches the Sanity webhook panel.
- [ ] `DATABASE_URL` points to the intended private database and is server-only.
- [ ] `KV_REST_API_URL` and `KV_REST_API_TOKEN` point to the intended Upstash Redis instance.
- [ ] `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` match the environment OAuth client.
- [ ] `HELCIM_GENERAL_API_TOKEN`, `HELCIM_TRANSACTION_API_TOKEN`, and `HELCIM_WEBHOOK_VERIFIER_TOKEN` are configured.
- [ ] `SERVICE_BOOKING_SQUARE_ENABLED=true` only where service booking checkout should use Square.
- [ ] `SQUARE_ENVIRONMENT`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_SERVICE_BOOKING_RETURN_URL`, and `SQUARE_SERVICE_BOOKING_WEBHOOK_URL` are configured only as server-side variables.
- [ ] `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_SEGMENT_MARKETING_ID`, `FROM_EMAIL`, and `ADMIN_EMAIL` are configured.

### Public Booking Entry Smoke

- [ ] Open `/booking` on the target environment and confirm the page renders.
- [ ] Confirm active bookable services appear in the intended order.
- [ ] Confirm appointment availability loads from the connected calendar.
- [ ] Confirm direct `/api/booking/create` requests reject with the secure-payment-required error.
- [ ] Confirm the booking marketing opt-in and no-opt-in paths create private audit evidence and do not create Sanity submission documents.

### Paid Service Booking Smoke

- [ ] Create a paid service booking hold in staging with test data.
- [ ] Start Square hosted checkout from the hold.
- [ ] Complete a Square sandbox/test payment.
- [ ] Confirm the private order transitions from pending to paid.
- [ ] Confirm Square return without server-side paid reconciliation does not finalize booking.
- [ ] Confirm the private hold transitions to booked or `paid_unbookable_rebooking_pending`.
- [ ] Confirm one Google Calendar event exists for the selected slot.
- [ ] Confirm Square return and webhook retries are idempotent.

### Paid Training Smoke

- [ ] Complete a paid training checkout in staging.
- [ ] Confirm Helcim payment marks the private enrollment/order paid.
- [ ] Confirm the customer receives the tokenized paid training schedule link.
- [ ] Confirm invalid, unpaid, expired, or wrong-program tokens do not reveal the Google Appointment Schedule URL.
- [ ] Confirm a valid token renders the Google Appointment Schedule link or embed.
- [ ] Confirm rendering the page does not mark the private enrollment scheduled.

### Sanity Revalidation Smoke

- [ ] Publish a small `bookingSettings` edit in the target Studio.
- [ ] Confirm `/api/revalidate` receives a signed webhook with projection `{ _type }`.
- [ ] Confirm the `bookingSettings` cache tag is expired and `/booking` updates.
- [ ] Publish or update one `service` record and confirm `/booking` reflects the change.

## Reconciliation Watchlist

At launch and after payment/calendar incidents, inspect private operational state for:

- Active service `held` holds past expiry.
- `payment_pending` holds older than the configured payment-success grace window.
- Paid service orders without Google Calendar event IDs.
- Expired holds that later received payment success.
- Orders or holds marked `booking_failed`, `manual_followup`, or `paid_unbookable_rebooking_pending`.
- Square webhook events that do not match a known private service order.
- Helcim webhook events that do not match a known product or training order.
- Duplicate webhook/idempotency keys.
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
- Upstash Redis is reachable for locks and OAuth token reads.

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
- The OAuth refresh token still exists in Redis.

Operator action:

1. Do not change the calendar ID blindly.
2. Reconnect OAuth with `/api/booking/oauth/start?secret=<BOOKING_ADMIN_SETUP_SECRET>` on the affected environment.
3. Rotate `BOOKING_ADMIN_SETUP_SECRET` if the setup URL may have been exposed.

### Hold Is Expired, Payment Pending, Or Manual Follow-Up

Check:

- Hold state and expiry timestamp in private Postgres.
- Checkout order status and provider references.
- Square order/payment references for service bookings, or Helcim invoice/payment references for product and training checkout.
- Square webhook delivery logs for service bookings, or Helcim webhook delivery logs for product and training checkout.
- Whether a Calendar event already exists for the hold metadata.

Operator action:

1. If payment did not succeed, release or let the hold expire and ask the customer to retry.
2. If service payment succeeded but the slot is no longer available, keep the record in `paid_unbookable_rebooking_pending`, offer a new slot first, verify replacement availability before Calendar event creation, and refund only after rebooking fails or staff chooses refund.
3. If Calendar insertion may have succeeded but the response was lost, search for the existing event before creating anything manually.

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

Operator action:

1. Do not roll back a confirmed booking only because email failed.
2. Record the Resend message/error ID with addresses redacted.
3. Check the relevant private DB email state/error field for the product order, training enrollment, or booking hold.
4. Send a manual customer follow-up if the booking, product order, or paid training instruction email failed.
5. Use `docs/resend-transactional-email-setup.md` for Resend sender/domain and environment troubleshooting.

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

| Situation | First action | Escalate to |
| --- | --- | --- |
| Booking page stale after publish | Verify Sanity webhook delivery, projection, and cache tag | Technical operator |
| Service payment succeeded but booking did not finalize | Preserve private records, inspect finalizer logs, check Calendar event existence | Technical operator and business owner |
| Customer paid for a service and slot is unavailable | Keep rebooking pending, offer alternate slot, verify availability before Calendar event, refund only if rebooking fails or staff chooses refund | Business owner |
| PII or payment data appears in Sanity | Stop affected flows and preserve evidence | Business/privacy owner and technical operator |
| Production migration concern | Stop; follow `docs/private-database-migration-runbook.md` | Migration approver |

Nataliea remains the accountable business/privacy owner. Dardan is the contract technical operator/steward while actively engaged. A post-contract operator or vendor must be named before launch for ongoing private-record operations.

## Safe Recovery Principles

- Private Postgres is canonical for sensitive booking/payment state.
- Search for an existing Calendar event before creating any manual replacement.
- Preserve idempotency keys and webhook event evidence.
- Prefer manual follow-up over silent retries when money has moved but booking state is uncertain.
- Do not delete or edit private production records casually. If schema changes are needed, use generated migrations and the migration runbook.
- Keep all incident evidence redacted.
