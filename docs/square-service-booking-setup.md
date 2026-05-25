# Square Service Booking Setup

Date: 2026-05-25

This runbook explains how to obtain the Square values used by paid service booking, configure Square webhooks, and set up local development, staging, and production.

Square is used only for paid service booking. Product checkout and training checkout remain Helcim-backed and must not require Square variables.

## App endpoints

| Purpose | Route |
| --- | --- |
| Customer return after hosted checkout | `/api/booking/square/return` |
| Square payment webhook | `/api/webhooks/square` |

The webhook handler verifies `x-square-hmacsha256-signature` using `SQUARE_WEBHOOK_SIGNATURE_KEY`, the exact `SQUARE_SERVICE_BOOKING_WEBHOOK_URL`, and the raw request body. If the configured webhook URL differs from the Square subscription URL, signature verification fails.

## Required environment variables

Add these as server-only variables. Never prefix Square values with `NEXT_PUBLIC_`.

```env
SERVICE_BOOKING_SQUARE_ENABLED=true
SQUARE_ENVIRONMENT=sandbox
SQUARE_ACCESS_TOKEN=<square-access-token>
SQUARE_LOCATION_ID=<square-location-id>
SQUARE_WEBHOOK_SIGNATURE_KEY=<square-webhook-signature-key>
SQUARE_SERVICE_BOOKING_RETURN_URL=https://<domain>/api/booking/square/return
SQUARE_SERVICE_BOOKING_WEBHOOK_URL=https://<domain>/api/webhooks/square
```

Related variables:

```env
PAYMENT_GATEWAY_MODE=live
# Optional migration cutoff for the Helcim-to-Square service-booking transition.
# SERVICE_BOOKING_HELCIM_LEGACY_CUTOFF_AT=2026-06-30T00:00:00Z
```

Use `PAYMENT_GATEWAY_MODE=mock` only for local/dev mock payment flows. Mock mode is rejected in production.

## Obtain Square values

Use the Square Developer Console for the target application. Square separates sandbox and production values, so collect each environment from the matching console mode.

1. Sign in to the Square Developer Console.
2. Open the Square application used for Lash Her service booking.
3. Choose the environment:
   - **Sandbox** for local sandbox testing and staging/preview.
   - **Production** for live production only.
4. Open **Credentials**.
5. Copy the access token into `SQUARE_ACCESS_TOKEN`.
6. Record the application ID for operator reference if needed, but this app does not currently require a `SQUARE_APPLICATION_ID` env var for hosted checkout.
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
6. Subscribe to payment events needed for hosted checkout reconciliation:
   - `payment.created`
   - `payment.updated`
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

### Option A: local mock Square flow

Use this for normal local development when you do not need Square-hosted checkout or live webhook delivery.

```env
SERVICE_BOOKING_SQUARE_ENABLED=true
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

### Option B: Square sandbox from local development

Use this only when you need to hit Square sandbox hosted checkout from your local app.

1. Create a public HTTPS tunnel to the local dev server, such as ngrok.
2. Use the tunnel origin for both URLs:

   ```env
   SERVICE_BOOKING_SQUARE_ENABLED=true
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
   PAYMENT_GATEWAY_MODE=live
   SQUARE_ENVIRONMENT=sandbox
   SQUARE_ACCESS_TOKEN=<sandbox-access-token>
   SQUARE_LOCATION_ID=<sandbox-location-id>
   SQUARE_WEBHOOK_SIGNATURE_KEY=<sandbox-signature-key>
   SQUARE_SERVICE_BOOKING_RETURN_URL=https://<staging-domain>/api/booking/square/return
   SQUARE_SERVICE_BOOKING_WEBHOOK_URL=https://<staging-domain>/api/webhooks/square
   ```

7. Redeploy staging after adding or changing variables.
8. Run a staging service-booking smoke test:
   - Create a paid service hold.
   - Continue to Square sandbox hosted checkout.
   - Complete a sandbox payment.
   - Confirm the Square return route redirects to booking confirmation.
   - Confirm the webhook finalizer records payment state idempotently.
   - Confirm exactly one Google Calendar event is created, or the booking moves to rebooking-first manual review if the slot is no longer bookable.

Staging Sanity must use `NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10` when `VERCEL_ENV=preview`.

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
   PAYMENT_GATEWAY_MODE=live
   SQUARE_ENVIRONMENT=production
   SQUARE_ACCESS_TOKEN=<production-access-token>
   SQUARE_LOCATION_ID=<production-location-id>
   SQUARE_WEBHOOK_SIGNATURE_KEY=<production-signature-key>
   SQUARE_SERVICE_BOOKING_RETURN_URL=https://<production-domain>/api/booking/square/return
   SQUARE_SERVICE_BOOKING_WEBHOOK_URL=https://<production-domain>/api/webhooks/square
   ```

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
- A finalization failure returns `503` so Square can retry.
- A verified, processed webhook returns `200`.

The app treats Square browser return as a lookup hint, not proof of payment. Payment and order status must reconcile server-side before a booking is finalized.

## Operational boundaries

- Square values are server-only secrets.
- Square service booking writes private payment and hold state to PostgreSQL, never Sanity.
- Use separate Square webhook subscriptions for local tunnel, staging, and production URLs.
- Keep staging and production Square credentials separate.
- Product checkout and training checkout remain Helcim-backed.
- Do not paste access tokens, signature keys, raw webhook bodies, full customer payloads, or payment identifiers into docs, tickets, or chat.
