# Square Service Booking Setup

Date: 2026-05-25

This runbook explains how to obtain the Square values used by paid service booking, configure Square webhooks, and set up local development, staging, and production.

Square is used only for paid service booking and for the optional training Afterpay Square Invoice flow when `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`. The primary confirmation flow stores a card on file using the Square Web Payments SDK and Square Cards API. When card-on-file is disabled or unavailable, the app falls back to the legacy Square hosted checkout (Payment Link) flow. Product checkout and default training checkout remain Helcim-backed and must not require Square variables. The optional training Square Invoice exception requires its own launch gate and environment setup; see `docs/training-afterpay-square-invoice.md`.

## App endpoints

| Purpose                                              | Route                                  |
| ---------------------------------------------------- | -------------------------------------- |
| Public Square Web Payments SDK config (card-on-file) | `/api/booking/square/config`           |
| Card-on-file service booking confirmation            | `/api/booking/card-on-file`            |
| Customer return after hosted checkout                | `/api/booking/square/return`           |
| Admin no-show charge against saved card              | `/api/admin/appointments/[id]/no-show` |
| Payment reconciliation monitor/cron                  | `/api/admin/payment-reconciliation`    |
| Square payment webhook                               | `/api/webhooks/square`                 |

The webhook handler verifies `x-square-hmacsha256-signature` using `SQUARE_WEBHOOK_SIGNATURE_KEY`, the exact `SQUARE_SERVICE_BOOKING_WEBHOOK_URL`, and the raw request body. If the configured webhook URL differs from the Square subscription URL, signature verification fails.

## Required environment variables

Add these as server-only variables. Never prefix Square values with `NEXT_PUBLIC_`.

### Base Square service booking variables

```env
SERVICE_BOOKING_SQUARE_ENABLED=true
SQUARE_ENVIRONMENT=sandbox
SQUARE_ACCESS_TOKEN=<square-access-token>
SQUARE_LOCATION_ID=<square-location-id>
SQUARE_WEBHOOK_SIGNATURE_KEY=<square-webhook-signature-key>
SQUARE_SERVICE_BOOKING_RETURN_URL=https://<domain>/api/booking/square/return
SQUARE_SERVICE_BOOKING_WEBHOOK_URL=https://<domain>/api/webhooks/square
```

### Card-on-file feature variables

Set these only when `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true`:

```env
SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true
SQUARE_APPLICATION_ID=<square-application-id>
PAYMENT_RECONCILIATION_CRON_SECRET=<reconciliation-cron-secret>
CRON_SECRET=<vercel-cron-secret>
BOOKING_ADMIN_PAYMENT_ACTION_SECRET=<secret>
```

- `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED` enables the Square Web Payments SDK card-save flow and the `POST /api/booking/card-on-file` confirmation path. Any value other than exactly `true` keeps the legacy hosted checkout fallback active.
- `SQUARE_APPLICATION_ID` is required for the browser-facing Square Web Payments SDK config route (`/api/booking/square/config`) and must match the application used for `SQUARE_ACCESS_TOKEN`. It is stored as a server environment variable (never `NEXT_PUBLIC_`) but is public-safe and not a secret; the app serves it to the browser so the SDK can initialize.
- `PAYMENT_RECONCILIATION_CRON_SECRET` enables and manually protects `GET /api/admin/payment-reconciliation`. It is required for the route to be enabled and for manual/staff checks.
- `CRON_SECRET` is required for Vercel scheduled cron authorization. The reconciliation route accepts `CRON_SECRET` only when `PAYMENT_RECONCILIATION_CRON_SECRET` is also configured.
- `BOOKING_ADMIN_PAYMENT_ACTION_SECRET` protects `POST /api/admin/appointments/[id]/no-show` staff no-show charge commands.

Related variables:

```env
PAYMENT_GATEWAY_MODE=live
# Optional migration cutoff for the Helcim-to-Square service-booking transition.
# SERVICE_BOOKING_HELCIM_LEGACY_CUTOFF_AT=2026-06-30T00:00:00Z
```

Use `PAYMENT_GATEWAY_MODE=mock` only for local/dev mock payment flows. Mock mode is rejected in production.

## Required Square APIs and OAuth scopes

The card-on-file flow plus legacy hosted checkout reconciliation use these Square APIs:

| Square API  | Purpose                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Customers` | Create or reuse a Square customer linked to the booking email/phone.                                                                     |
| `Cards`     | Save a tokenized card on file and retrieve display metadata (brand, last 4, expiry).                                                     |
| `Orders`    | Create a draft order for the authorized no-show maximum charge amount.                                                                   |
| `Invoices`  | Create and publish draft invoices with `automatic_payment_source: "CARD_ON_FILE"` for manual no-show enforcement.                        |
| `Payments`  | Reconcile Payment Link payments on the legacy path. Not used for direct card-on-file charges; no-show enforcement uses Invoices instead. |

If you are using OAuth to authorize the application (rather than a personal access token), request at least these scopes:

- `CUSTOMERS_READ`
- `CUSTOMERS_WRITE`
- `CARDS_READ`
- `CARDS_WRITE`
- `ORDERS_READ`
- `ORDERS_WRITE`
- `INVOICES_READ`
- `INVOICES_WRITE`
- `PAYMENTS_READ`
- `PAYMENTS_WRITE`

The hosted-checkout-only legacy path needs only `ORDERS_READ`, `PAYMENTS_READ`, `PAYMENTS_WRITE`, and the webhook subscription for payment events. Card-on-file expands that to Customers, Cards, and Invoices.

## Obtain Square values

Use the Square Developer Console for the target application. Square separates sandbox and production values, so collect each environment from the matching console mode.

1. Sign in to the Square Developer Console.
2. Open the Square application used for Lash Her service booking.
3. Choose the environment:
   - **Sandbox** for local sandbox testing and staging/preview.
   - **Production** for live production only.
4. Open **Credentials**.
5. Copy the access token into `SQUARE_ACCESS_TOKEN`.
6. Copy the **Application ID** into `SQUARE_APPLICATION_ID`. This is required for the card-on-file flow and must match the access token's application. It is public-safe and exposed through `/api/booking/square/config`; it is not required for the legacy hosted checkout fallback.
7. Open **Locations** for the same environment.
8. Copy the target location ID into `SQUARE_LOCATION_ID`.

Do not mix sandbox tokens with production locations or production tokens with sandbox locations.

## Create the Square webhook subscription

Create one subscription per reachable environment URL. Local mock mode does not need a Square webhook subscription.

1. In the Square Developer Console, open the same application and environment used for the access token.
2. Go to **Webhooks** or **Webhooks > Subscriptions**.
3. Add a subscription for the environment.
4. Set the notification URL to the exact app webhook URL:

   ```text
   https://<domain>/api/webhooks/square
   ```

5. Select the Square API version used by the app. Current app client requests use Square version `2026-05-20`.
6. Subscribe to the events the app needs:
   - For card-on-file no-show invoices and legacy hosted checkout reconciliation:
     - `payment.created`
     - `payment.updated`
   - For no-show invoice lifecycle (card-on-file flow):
     - `invoice.created`
     - `invoice.published`
     - `invoice.updated`
     - `invoice.payment_made`
     - `invoice.canceled`
     - `invoice.scheduled_charge_failed`
   - For order-side reconciliation:
     - `order.updated`
7. Save the subscription.
8. Open the subscription details and reveal/copy the signature key.
9. Store that key in `SQUARE_WEBHOOK_SIGNATURE_KEY` for the same app environment.
10. Store the exact notification URL in `SQUARE_SERVICE_BOOKING_WEBHOOK_URL`.

If the webhook URL changes, update both the Square subscription and `SQUARE_SERVICE_BOOKING_WEBHOOK_URL`, then redeploy or restart the app.

## Local development

Start from `.env.local.example`:

```bash
cp .env.local.example .env.local
```

### Option A: local mock legacy Square flow

Use this for normal local development when you do not need Square-hosted checkout, live webhook delivery, or card-on-file sandbox testing.

```env
SERVICE_BOOKING_SQUARE_ENABLED=true
SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=false
PAYMENT_GATEWAY_MODE=mock
PAYMENT_MOCK_DEFAULT_SCENARIO=success
SQUARE_ENVIRONMENT=sandbox
SQUARE_SERVICE_BOOKING_RETURN_URL=http://localhost:3000/api/booking/square/return
SQUARE_SERVICE_BOOKING_WEBHOOK_URL=http://localhost:3000/api/webhooks/square
```

In mock mode, the runtime supplies mock Square credentials when `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, or `SQUARE_WEBHOOK_SIGNATURE_KEY` are omitted. You can still set placeholder values for clarity.

Run the app:

```bash
npm run dev
```

Then exercise a paid service booking. The booking checkout should use the mock Square client and return through the local Square return route.

### Option B: local Square sandbox card-on-file flow

Use this when you need to test the Square Web Payments SDK tokenization, Cards API, no-show invoice behavior, and admin no-show charge flow from your local app.

1. Create a public HTTPS tunnel to the local dev server, such as ngrok.
2. Use the tunnel origin for the card-on-file and webhook URLs:

   ```env
   SERVICE_BOOKING_SQUARE_ENABLED=true
   SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true
   PAYMENT_GATEWAY_MODE=live
   SQUARE_ENVIRONMENT=sandbox
   SQUARE_ACCESS_TOKEN=<sandbox-access-token>
   SQUARE_APPLICATION_ID=<sandbox-application-id>
   SQUARE_LOCATION_ID=<sandbox-location-id>
   SQUARE_SERVICE_BOOKING_RETURN_URL=https://<tunnel-domain>/api/booking/square/return
   SQUARE_SERVICE_BOOKING_WEBHOOK_URL=https://<tunnel-domain>/api/webhooks/square
    SQUARE_WEBHOOK_SIGNATURE_KEY=<sandbox-subscription-signature-key>
    CRON_SECRET=local-dev-vercel-cron-secret
    PAYMENT_RECONCILIATION_CRON_SECRET=local-dev-cron-secret
    BOOKING_ADMIN_PAYMENT_ACTION_SECRET=local-dev-admin-secret
   ```

3. Create or update the Square sandbox webhook subscription to use the tunnel webhook URL.
4. Restart `npm run dev` after changing `.env.local`.
5. Run a sandbox service booking:
   - Confirm the policy checkbox blocks submission until accepted.
   - Complete card tokenization and save.
   - Confirm the hold transitions to `booked` with a saved card, policy acceptance, no-show record, and Google Calendar event.
   - Test the admin no-show charge route against the saved sandbox card.

When the tunnel URL rotates, update the Square sandbox webhook subscription and `SQUARE_SERVICE_BOOKING_WEBHOOK_URL` together.

### Option C: local Square sandbox hosted checkout (legacy fallback)

Use this only when you need to hit the legacy Square hosted checkout from your local app.

1. Create a public HTTPS tunnel to the local dev server, such as ngrok.
2. Use the tunnel origin for both URLs:

   ```env
   SERVICE_BOOKING_SQUARE_ENABLED=true
   SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=false
   PAYMENT_GATEWAY_MODE=live
   SQUARE_ENVIRONMENT=sandbox
   SQUARE_ACCESS_TOKEN=<sandbox-access-token>
   SQUARE_LOCATION_ID=<sandbox-location-id>
   SQUARE_SERVICE_BOOKING_RETURN_URL=https://<tunnel-domain>/api/booking/square/return
   SQUARE_SERVICE_BOOKING_WEBHOOK_URL=https://<tunnel-domain>/api/webhooks/square
   SQUARE_WEBHOOK_SIGNATURE_KEY=<sandbox-subscription-signature-key>
   ```

3. Create or update the Square sandbox webhook subscription to use the tunnel webhook URL.
4. Restart `npm run dev` after changing `.env.local`.
5. Run a sandbox hosted checkout and confirm Square can deliver the webhook to the tunnel URL.

When the tunnel URL rotates, update the Square sandbox webhook subscription and `SQUARE_SERVICE_BOOKING_WEBHOOK_URL` together.

## Staging setup

Use Square sandbox values in Vercel Preview/staging.

1. Confirm the staging app URL.
2. In Square Developer Console, switch to **Sandbox**.
3. Collect the sandbox access token and sandbox location ID.
4. Create a sandbox webhook subscription with:

   ```text
   https://<staging-domain>/api/webhooks/square
   ```

5. Copy the sandbox subscription signature key.
6. Add these variables to the staging/preview environment only:

   ```env
   SERVICE_BOOKING_SQUARE_ENABLED=true
   SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true
   PAYMENT_GATEWAY_MODE=live
   SQUARE_ENVIRONMENT=sandbox
   SQUARE_ACCESS_TOKEN=<sandbox-access-token>
   SQUARE_APPLICATION_ID=<sandbox-application-id>
   SQUARE_LOCATION_ID=<sandbox-location-id>
   SQUARE_WEBHOOK_SIGNATURE_KEY=<sandbox-signature-key>
   SQUARE_SERVICE_BOOKING_RETURN_URL=https://<staging-domain>/api/booking/square/return
   SQUARE_SERVICE_BOOKING_WEBHOOK_URL=https://<staging-domain>/api/webhooks/square
   CRON_SECRET=<staging-cron-secret>
   PAYMENT_RECONCILIATION_CRON_SECRET=<staging-reconciliation-cron-secret>
   BOOKING_ADMIN_PAYMENT_ACTION_SECRET=<staging-admin-secret>
   ```

7. Redeploy staging after adding or changing variables.
8. Run a staging service-booking smoke test:
   - Create a paid service hold.
   - When card-on-file is enabled, confirm policy acceptance is required, tokenize and save a sandbox card, and confirm the hold moves to `booked` with a saved card reference, policy acceptance, no-show record, and one Google Calendar event.
   - When card-on-file is disabled, continue to Square sandbox hosted checkout (legacy fallback), complete a sandbox payment, and confirm the Square return route redirects to booking confirmation.
   - Confirm Square return without server-side reconciliation does not finalize booking.
   - Confirm the webhook finalizer records payment or no-show state idempotently.
   - Confirm exactly one Google Calendar event is created, or the booking moves to rebooking-first manual review if the slot is no longer bookable.
   - Test the admin no-show charge route in sandbox when card-on-file is enabled.

Staging Sanity must use `NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10` when `VERCEL_ENV=preview`.

## Card-on-file staging certification order

Run this sequence in staging before requesting production card-on-file enablement. The goal is to prove the full Square sandbox lifecycle with real provider behavior and capture evidence in `docs/superpowers/reports/square-card-on-file-sandbox-certification.md`.

### Before the sequence

1. Confirm `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED` is **not** set to `true` in production.
2. Run the environment preflight script against staging variables:

   ```bash
   npm run check:square-card-on-file-env
   ```

   The script lists missing variable names only and never prints their values.

3. Apply the latest private DB migrations to the staging database and verify the hold-side no-show/policy foreign keys are present.
4. Run DB-backed tests against a migrated staging clone. Load `TEST_DATABASE_URL` from a protected env file or secret session before running the command; do not print or paste the connection string into shell history, tickets, or docs.

   ```bash
   npx tsx --test src/lib/private-db/card-on-file-repository.db.test.ts src/lib/booking/payments/service-reconciliation-monitor.test.ts
   ```

5. Deploy or rebuild staging with the latest code and confirm `npm run build` passes locally.
6. Run browser smoke tests:

   ```bash
   npx playwright test tests/booking.spec.ts --project=chromium
   npx playwright test tests/booking-card-on-file-config.spec.ts --project=chromium
   ```

### Staging smoke sequence

1. Confirm production flag remains off.
2. Apply latest private DB migrations to staging.
3. Run DB-backed tests against staging clone.
4. Enable `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true` only in staging with Square sandbox credentials.
5. Complete one successful booking through Square Web Payments SDK `STORE` tokenization.
6. Verify Square customer, card, order, and DRAFT invoice in Square sandbox.
7. Trigger the admin no-show route after the appointment end time. The request body must match the implemented contract exactly and the amount must equal the appointment max charge:

   ```json
   {
     "amountCents": <appointment-max-charge-cents>,
     "confirmPolicyCharge": true,
     "idempotencyKey": "<unique-key-for-this-attempt>",
     "operatorId": "<operator-alias>",
     "reason": "<concise-no-show-reason>"
   }
   ```

   The route rejects mismatched amounts with `NO_SHOW_AMOUNT_MUST_EQUAL_MAX_CHARGE` and returns `allowedAmountCents`. Do not guess the amount; read it from the booked hold's no-show charge record.

8. Verify webhook finalizes the no-show charge and records a sanitized event.
9. Run payment reconciliation route with the staging cron secret and save the JSON result.
10. Force and observe a safe `manual_followup` state without an unsafe duplicate charge. Use a second sandbox appointment with a saved card and call the admin no-show route while the Square service booking environment is disabled or null (e.g., in a controlled local staging DB clone or dedicated preview deployment with `SERVICE_BOOKING_SQUARE_ENABLED` unset or explicitly `false`). This controlled disabled/null state is what produces `manual_followup`. A malformed or incomplete enabled Square service booking environment (for example, missing or invalid `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, or webhook values while `SERVICE_BOOKING_SQUARE_ENABLED=true`) may instead return `charge_failed` and is not the same signal. Confirm:
    - The response status is `202` and `chargeStatus` is `manual_followup`.
    - The no-show charge record contains `admin_operator_id`, `admin_reason`, `admin_action_at`, and `admin_eligibility_checked_at`.
    - No new Square no-show invoice publish/payment is created by this admin action; any pre-existing saved-card/order/draft-invoice evidence remains redacted.
    - Replaying the same request with the same `idempotencyKey` returns the same `manual_followup` state without creating a second audit entry or charge attempt.
    - Do not retry with a different `idempotencyKey` before confirming the record state; preserve the original idempotency key and webhook/event evidence for escalation.

    Record only redacted evidence: appointment/hold reference, operator alias, UTC timestamps, and the fact that `manual_followup` was observed. Do not record raw `sourceId`, verification tokens, full Square object IDs, or PII.

11. Disable the staging flag if any scenario produces `manual_followup`, unreconciled `charge_pending`, or provider mismatch.

### Certification report and go/no-go

- Record every step, timestamp, and redacted evidence row in `docs/superpowers/reports/square-card-on-file-sandbox-certification.md`.
- Safe evidence handling: no admin setup URLs, no raw Square tokens/source IDs, no `DATABASE_URL` paste, and no customer PII in the report or chat.
- Production `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true` remains disabled until the certification report is complete, operator-approved, and the reconciliation route returns `ok: true` with no unresolved `manual_followup`, `charge_pending`, or provider mismatch states.

## Production setup

Production setup should happen only after staging smoke passes.

1. Confirm the production app URL.
2. In Square Developer Console, switch to **Production**.
3. Collect the production access token and production location ID.
4. Create a production webhook subscription with:

   ```text
   https://<production-domain>/api/webhooks/square
   ```

5. Copy the production subscription signature key.
6. Add these variables to the Vercel Production environment only:

   ```env
   SERVICE_BOOKING_SQUARE_ENABLED=true
   SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true
   PAYMENT_GATEWAY_MODE=live
   SQUARE_ENVIRONMENT=production
   SQUARE_ACCESS_TOKEN=<production-access-token>
   SQUARE_APPLICATION_ID=<production-application-id>
   SQUARE_LOCATION_ID=<production-location-id>
   SQUARE_WEBHOOK_SIGNATURE_KEY=<production-signature-key>
   SQUARE_SERVICE_BOOKING_RETURN_URL=https://<production-domain>/api/booking/square/return
   SQUARE_SERVICE_BOOKING_WEBHOOK_URL=https://<production-domain>/api/webhooks/square
    CRON_SECRET=<production-vercel-cron-secret>
    PAYMENT_RECONCILIATION_CRON_SECRET=<production-reconciliation-cron-secret>
    BOOKING_ADMIN_PAYMENT_ACTION_SECRET=<production-admin-secret>
   ```

   Use distinct values for `CRON_SECRET` and `PAYMENT_RECONCILIATION_CRON_SECRET` if the route requires separation between Vercel scheduled cron authorization and manual/staff access.

7. Confirm production Sanity uses `NEXT_PUBLIC_SANITY_DATASET=production` when `VERCEL_ENV=production`.
8. Confirm `PAYMENT_GATEWAY_MODE` is not `mock`.
9. Redeploy production.
10. Run a low-risk production smoke or Square webhook test event if the business owner approves.

Stop production promotion if webhook signatures fail, Square credentials are scoped to the wrong environment, the production webhook URL is not HTTPS, or payment reconciliation cannot finalize Calendar state.

## Testing webhook delivery

Square supports test webhook delivery for a saved subscription. Use an event type already included in the subscription, such as `payment.updated`.

Expected app behavior:

- Missing or invalid `x-square-hmacsha256-signature` returns `401`.
- Malformed JSON returns `400`.
- A retryable infrastructure or Square lookup failure returns `503` so Square can retry.
- A verified, processed webhook returns `200`, including events that require manual review after alerting.

The app treats Square browser return as a lookup hint, not proof of payment. Payment, order, and invoice status must reconcile server-side before a booking or no-show charge is finalized.

## Optional training Afterpay Square Invoice

There is a separate, optional training-only checkout path that creates a Square invoice so customers can pay for training with Afterpay/Clearpay. It is controlled by the server-only feature flag `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED` and is disabled by default.

- Do not enable this flow in production until Square merchant eligibility for live CAD invoices is verified.
- It uses the same Square credentials and `/api/webhooks/square` route as service booking, but training invoice events must be routed to the training Square Invoice finalizer before any service-booking or no-show reconciliation.
- Product checkout and default training checkout remain Helcim-backed.

See `docs/training-afterpay-square-invoice.md` for the feature flag, dashboard prerequisites, webhook events, recovery steps, evidence checklist, and launch gate.

## Operational boundaries

- Square values are server-side configuration. `SQUARE_APPLICATION_ID` is public-safe and served to the browser via `/api/booking/square/config`; all other Square values (access tokens, signature keys, cron/admin secrets) are secrets.
- Square service booking writes private payment and hold state to PostgreSQL, never Sanity.
- Use separate Square webhook subscriptions for local tunnel, staging, and production URLs.
- Keep staging and production Square credentials separate.
- Product checkout and default training checkout remain Helcim-backed.
- Do not paste access tokens, signature keys, raw webhook bodies, full customer payloads, or payment identifiers into docs, tickets, or chat.
