# Booking System Runbook

Date: 2026-05-19

Use this runbook when operating, smoke testing, or troubleshooting Lash Her booking flows in staging or production. It assumes the unified booking system is live: customers select slots in the Lash Her app, payment is handled by Helcim when required, and confirmed events are created on the connected Google Calendar.

## System Boundaries

| System | Operator responsibility | Must not become |
| --- | --- | --- |
| Sanity | Public booking copy, booking settings, booking offerings, native payment fields, cache revalidation | Storage for PII, payment state, holds, booking history, or transaction records |
| Private Postgres | Holds, checkout orders, payment events, appointment state, training enrollments, reconciliation data | Public CMS or browser-readable data source |
| Upstash Redis | Google Calendar OAuth refresh token, calendar locks, idempotency keys, short-lived contention locks | Canonical payment or booking storage |
| Google Calendar | Staff source of truth for final booked events and busy intervals | Payment gate or appointment-schedule engine |
| Helcim | Checkout initialization, payment approval, webhook event source | Sole authority for final booking state |
| Resend | Customer/admin transactional emails | Source of truth for booking success |

If a record contains customer contact data, payment identifiers, hold state, or reconciliation metadata, treat it as private Postgres data. Do not move it into Sanity.

## Live Flows

### Standard Public Booking

1. Customer opens `/booking`.
2. The page loads Sanity `bookingSettings` and active `bookingOffering` records.
3. The browser requests availability from `/api/booking/availability`.
4. The server builds slots from configured availability marker events, Google Calendar busy intervals, private active holds, lead time, horizon, duration, intervals, and buffers.
5. Training calls submit through `/api/booking/create`; in-person appointments must use the paid appointment hold/checkout flow.
6. The server revalidates the slot before creating or confirming the booking. Direct unpaid in-person appointment creation is rejected.
7. A Google Calendar event is inserted or reused.
8. Booking confirmation emails are attempted through Resend. Email failure does not undo a confirmed booking.

### Paid Appointment With Hold And Helcim Payment

1. Customer selects a paid booking offering and slot.
2. `/api/booking/holds` revalidates the slot and creates a private hold with an immutable snapshot of the selected deposit/full/custom-partial payment amount.
3. `/api/booking/checkout` initializes the Helcim checkout from the hold snapshot, creates or updates a pending private order, and marks the hold `payment_pending`.
4. Payment success may arrive from browser validation, the Helcim webhook, or both.
5. `/api/checkout/validate-payment` and `/api/webhooks/card-transactions` both route through the shared appointment finalizer.
6. The finalizer verifies payment, locks the relevant state, reuses or creates the Google Calendar event, marks the hold booked, persists payment evidence, and sends emails non-blockingly.

Duplicate browser/webhook success should produce one final booking, not duplicate Calendar events.

### Paid Training Intro Call

1. Training checkout completes through the commerce checkout flow.
2. The private training enrollment/order is marked paid.
3. The customer receives the order-based scheduling path: `/booking?type=training-call&order=<order-reference>`.
4. The booking form asks for the checkout email. The email is sent in the secure request body, not in the URL.
5. The server matches the order reference and checkout email against private training enrollment state before exposing training-call availability.
6. The resulting booking is forced to the `training-call` type and marked scheduled/booked in private state after Calendar event creation.

Legacy tokenized training links are retired. If a customer presents one, do not try to use it; find the paid training order reference and use the order-based booking path.

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
- [ ] `RESEND_API_KEY`, `FROM_EMAIL`, and `ADMIN_EMAIL` are configured.

### Booking Smoke

- [ ] Open `/booking` on the target environment and confirm the page renders.
- [ ] Confirm active booking offerings appear in the intended order.
- [ ] Confirm standard appointment availability loads from the connected calendar.
- [ ] Create a standard test booking with a redacted customer profile and confirm one Google Calendar event exists.
- [ ] Confirm the booking confirmation email is delivered or that any email failure is logged without rolling back the booking.
- [ ] Confirm the booking marketing opt-in and no-opt-in paths create private audit evidence and do not create Sanity submission documents.

### Paid Appointment Smoke

- [ ] Create a paid appointment hold in staging with test data.
- [ ] Start Helcim checkout from the hold.
- [ ] Complete a staging/test payment.
- [ ] Confirm the private order transitions from pending to paid.
- [ ] Confirm the private hold transitions to booked or manual follow-up.
- [ ] Confirm one Google Calendar event exists for the selected slot.
- [ ] Confirm browser validation and webhook retries are idempotent.

### Paid Training Smoke

- [ ] Complete a paid training checkout in staging.
- [ ] Confirm the customer receives an order-based scheduling link.
- [ ] Confirm the training booking gate rejects the wrong checkout email.
- [ ] Confirm the correct checkout email loads `training-call` availability.
- [ ] Create the training intro-call booking and verify the private enrollment is marked scheduled/booked.
- [ ] Confirm one Google Calendar event exists with redacted training metadata evidence.

### Sanity Revalidation Smoke

- [ ] Publish a small `bookingSettings` edit in the target Studio.
- [ ] Confirm `/api/revalidate` receives a signed webhook with projection `{ _type }`.
- [ ] Confirm the `bookingSettings` cache tag is expired and `/booking` updates.
- [ ] Publish or update one `bookingOffering` record and confirm `/booking` reflects the change.

## Reconciliation Watchlist

At launch and after payment/calendar incidents, inspect private operational state for:

- Active `held` holds past expiry.
- `payment_pending` holds older than the configured payment-success grace window.
- Paid orders without Google Calendar event IDs.
- Expired holds that later received payment success.
- Orders or holds marked `booking_failed` or `manual_followup`.
- Helcim webhook events that do not match a known private order.
- Duplicate webhook/idempotency keys.
- Paid training enrollments not yet booked.
- Calendar events created without a matching private booking record.

Evidence must be redacted. Do not paste customer emails, phone numbers, raw webhook bodies, full connection strings, payment tokens, or complete transaction identifiers into tickets or release notes.

## Troubleshooting

### `/booking` Does Not Load

Check:

- Sanity public env vars and dataset target.
- `bookingSettings` singleton exists and is published.
- At least one active `bookingOffering` exists for the expected booking type.
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
- Checkout order status and Helcim invoice/payment references.
- Helcim webhook delivery logs.
- Whether a Calendar event already exists for the hold metadata.

Operator action:

1. If payment did not succeed, release or let the hold expire and ask the customer to retry.
2. If payment succeeded but the slot is no longer available, keep the record in manual follow-up and offer a new slot before any refund decision.
3. If Calendar insertion may have succeeded but the response was lost, search for the existing event before creating anything manually.

### Helcim Webhook Or Payment Verification Fails

Check:

- Webhook URL is `https://<domain>/api/webhooks/card-transactions` and uses HTTPS.
- The URL does not include forbidden provider wording from the Helcim dashboard rules.
- `HELCIM_WEBHOOK_VERIFIER_TOKEN` matches the Helcim dashboard verifier.
- General and transaction API tokens are in the correct environment.
- Private payment-event idempotency rows are being recorded.

Operator action:

1. Use Helcim dashboard delivery status and Vercel logs to identify the failed event.
2. Do not replay the same event manually unless idempotency evidence is understood.
3. If browser validation succeeded but webhook failed, confirm the shared finalizer already booked the hold before retrying anything.

### Email Does Not Send

Check:

- `RESEND_API_KEY`, `FROM_EMAIL`, and `ADMIN_EMAIL` are configured.
- The sender domain is verified in Resend.
- Vercel logs show the email error after the private state transition.

Operator action:

1. Do not roll back a confirmed booking only because email failed.
2. Record the Resend message/error ID with addresses redacted.
3. Send a manual customer follow-up if the booking or paid training instruction email failed.

### Customer Cannot Access Paid Training Booking

Check:

- The order reference belongs to a paid training enrollment.
- The customer is entering the checkout email, not another contact address.
- The booking path contains `type=training-call` and the order reference.
- Availability requests are using the secure request body for email verification.

Operator action:

1. Verify the paid training enrollment in private Postgres.
2. Send the customer the order-based booking path again.
3. If the email is wrong because checkout data was entered incorrectly, escalate for a private record correction decision; do not bypass eligibility in Sanity.

## Stop Conditions

Stop the launch or release window if any of these occur:

- Production `DATABASE_URL` cannot be verified as the intended target.
- Production backup/PITR is unavailable before an approved migration window.
- Customer PII, payment state, or booking history appears in Sanity.
- Live booking or form flows create new Sanity submission documents.
- Paid payment succeeds but the finalizer repeatedly fails to book or mark manual follow-up.
- Helcim webhook signatures cannot be verified.
- Google Calendar writes fail for confirmed paid bookings.
- Public booking accepts a retired tokenized handoff.

## Escalation

| Situation | First action | Escalate to |
| --- | --- | --- |
| Booking page stale after publish | Verify Sanity webhook delivery, projection, and cache tag | Technical operator |
| Payment succeeded but booking did not finalize | Preserve private records, inspect finalizer logs, check Calendar event existence | Technical operator and business owner |
| Customer paid and slot is unavailable | Mark/manual-follow-up, offer alternate slot before refund decision | Business owner |
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
