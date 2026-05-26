# Training Afterpay Square Invoice Runbook

Date: 2026-05-25

This runbook explains how to operate the training-only Afterpay buy now, pay later flow through Square Invoices. The feature is for paid training enrollments only. Product checkout and service booking keep their existing payment paths.

The feature is intentionally disabled by default and must stay disabled in production until Square merchant eligibility is verified for live CAD invoices.

## Overview

Training Afterpay Square Invoice checkout creates a Square invoice for a training order, publishes it through Square, and waits for Square to confirm payment before the app finalizes the paid training enrollment.

Operational boundaries:

1. Square is the invoice and Afterpay payment provider for this flow.
2. PostgreSQL remains the source of truth for private training order, payment, and enrollment state.
3. Sanity remains editorial only and must not receive training enrollment records, payment history, payment tokens, or customer PII from live checkout.
4. A paid invoice does not count as finalized until the app records the paid state and completes the training enrollment finalization steps.

## Environment variables

Add the feature flag as a server-only variable. Never prefix Square or training payment values with `NEXT_PUBLIC_`.

```env
TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=false
```

Use the existing Square credentials for the target environment:

```env
SQUARE_ENVIRONMENT=sandbox
SQUARE_ACCESS_TOKEN=<square-access-token>
SQUARE_LOCATION_ID=<square-location-id>
SQUARE_WEBHOOK_SIGNATURE_KEY=<square-webhook-signature-key>
SQUARE_SERVICE_BOOKING_WEBHOOK_URL=https://<domain>/api/webhooks/square
```

Related runtime variables still apply:

```env
PAYMENT_GATEWAY_MODE=live
DATABASE_URL=<postgres-url>
```

Use `PAYMENT_GATEWAY_MODE=mock` only for local and dev payment tests. Mock mode is rejected in production. Do not add actual API keys, tokens, webhook signature keys, database URLs, or sensitive setup URLs to this document or to launch evidence.

## Feature flag rollout

The feature flag defaults to disabled when absent and enables only when set to the exact string `true`.

Recommended rollout:

1. Keep `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=false` locally unless you are testing this exact flow.
2. Enable in local or preview only with Square sandbox credentials or approved mock payment mode.
3. Complete route, webhook, private database, and finalization evidence in staging.
4. Confirm Square merchant eligibility for production Afterpay/Clearpay on CAD invoices.
5. Enable `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true` in production only after the launch gate is complete.

If eligibility, webhook delivery, or finalization evidence is missing, leave the flag disabled.

## Square dashboard prerequisites

Before enabling the feature for a target environment, confirm the Square application and merchant account are configured for invoices and Afterpay/Clearpay.

Required dashboard checks:

1. The Square application is opened in the correct environment, sandbox for preview and production for live traffic.
2. `SQUARE_ACCESS_TOKEN` and `SQUARE_LOCATION_ID` come from the same Square environment.
3. Square Invoices are available for the selected location.
4. Afterpay/Clearpay is enabled for invoices in CAD for the merchant account and location.
5. The webhook subscription points to the app Square webhook route for the target deployment:

```text
https://<domain>/api/webhooks/square
```

6. The subscription signature key is stored in `SQUARE_WEBHOOK_SIGNATURE_KEY` for the same environment.
7. The exact webhook URL is stored in `SQUARE_SERVICE_BOOKING_WEBHOOK_URL` so signature verification uses the same URL Square signs.

Do not claim sandbox testing proves live Afterpay approval. Sandbox only proves the app flow and webhook handling. Live merchant eligibility must be verified separately in Square before production enablement.

## Webhook events

The Square webhook route is shared with service booking. Training Square Invoice finalization is intentionally narrow.

Primary event:

1. `invoice.payment_made`: the only event that triggers training Square Invoice finalization.

Acknowledged events:

1. `invoice.published`: may be recorded or observed for invoice lifecycle context, but it does not finalize training enrollment.
2. `invoice.updated`: may be recorded or observed for invoice lifecycle context, but it does not finalize training enrollment.
3. Other verified Square events continue through the existing Square webhook path and must not finalize training invoice orders unless explicitly added in code later.

Expected webhook behavior:

1. Missing or invalid `x-square-hmacsha256-signature` returns `401`.
2. Malformed JSON returns `400`.
3. A verified but non-finalizing event returns successfully without creating a training enrollment.
4. A paid invoice that cannot finalize returns a retryable failure so Square can redeliver the event.

## BALANCE payment constraint

Training Afterpay Square Invoice uses one Square invoice payment request with `request_type` set to `BALANCE`.

Deposits, installments, split invoice schedules, and partial training payments are out of scope for this feature. Do not configure or document training deposits or installment plans for this flow unless the code and operations process are changed first.

## Recovery steps

Use these steps when Square shows a paid invoice but the app did not finish training enrollment finalization.

1. Confirm the incident is for a training Square Invoice order, not service booking or Helcim checkout.
2. In Square, verify the invoice is paid and collect only redacted evidence: invoice ID, order ID, payment timestamp, amount, currency, and event ID. Do not copy card data, tokens, raw webhook bodies, or customer PII into tickets.
3. In app logs, find the matching `/api/webhooks/square` delivery for `invoice.payment_made` and record the HTTP status, deployment, timestamp, and redacted invoice ID.
4. In the private database, confirm the local order exists with `paymentProvider="square"`, the Square invoice ID in provider checkout data, the expected Square order ID, amount, currency `CAD`, and training Square invoice metadata.
5. Check whether the finalizer marked the order as paid, created the training enrollment, generated the paid scheduling token, and sent the staff alert.
6. If the webhook returned a retryable failure, allow Square retry delivery after correcting the root cause, such as missing env vars, database connectivity, mismatched invoice/order IDs, or amount/currency mismatch.
7. If Square will not retry, use the approved internal retry procedure for the paid invoice finalizer. Run it only against the verified invoice/order pair and record redacted evidence before and after.
8. If the invoice, local order, amount, currency, or correlation ID does not match, stop. Do not manually mark the order paid. Escalate to the technical operator for reconciliation.
9. Notify the customer only after the private order and enrollment state are finalized or the business owner approves manual follow-up.

## Evidence checklist

Record evidence for staging and production separately. Redact names, email addresses, phone numbers, addresses, payment tokens, raw webhook bodies, and secrets.

Commands and checks to capture:

```bash
npm run lint
npm run test:unit
npm run build
VERCEL_ENV=preview node scripts/validate-sanity-env.mjs
VERCEL_ENV=production node scripts/validate-sanity-env.mjs
```

Staging flow evidence:

1. `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true` is set only for the intended staging or preview deployment.
2. `PAYMENT_GATEWAY_MODE=live` uses Square sandbox credentials, or local mock mode is clearly labeled as mock evidence.
3. A training checkout creates and publishes a Square invoice with amount and currency `CAD`.
4. The Square invoice uses Afterpay/Clearpay as an available payment method in the target environment.
5. The app stores the private order with the expected Square invoice ID, Square order ID, correlation ID, amount, and currency.
6. `invoice.payment_made` reaches `/api/webhooks/square` with a valid signature.
7. The finalizer marks the private order paid and creates exactly one training enrollment.
8. Retried webhook delivery is idempotent and does not duplicate enrollment, scheduling token, payment event, or notification side effects.
9. Non-primary invoice events do not finalize enrollment.
10. Evidence redacts customer PII and never includes Square access tokens, webhook signature keys, database URLs, or raw payment payloads.

Production launch evidence:

1. Merchant eligibility verification is recorded for live Afterpay/Clearpay CAD invoices.
2. Production Square credentials are scoped to production and use the production location.
3. The production webhook subscription URL exactly matches the deployed app webhook URL and the configured `SQUARE_SERVICE_BOOKING_WEBHOOK_URL`.
4. `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true` is set only after eligibility and staging evidence are approved.
5. A low-risk production smoke test or approved Square invoice test is recorded with redacted invoice/order references.

## Launch gate

Production enablement is blocked until Square merchant eligibility is verified for live Afterpay/Clearpay on CAD invoices.

Stop production enablement if any of these are true:

1. Square has not confirmed Afterpay/Clearpay eligibility for the merchant, location, invoice product, and CAD currency.
2. Staging evidence only proves mock behavior.
3. Sandbox evidence is being treated as live Afterpay approval.
4. The production webhook URL, signature key, access token, or location ID cannot be matched to the same Square production application.
5. A paid invoice cannot be reconciled to one private training order before enrollment finalization.
6. Recovery ownership for failed finalization is not assigned for launch day.

Keep `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=false` in production until all launch gate items are complete.
