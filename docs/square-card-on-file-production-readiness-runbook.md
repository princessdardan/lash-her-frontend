# Square Card-on-File Production Readiness Runbook

## Purpose

Use this runbook to move Square card-on-file service booking from **NO-GO** to approved production enablement. The staging branch is currently live on the Vercel preview deployment at <https://preview.lashher.com>. Production must remain disabled until staging proves the full Square sandbox lifecycle with a migrated private PostgreSQL database, real Square sandbox webhooks, and safe reconciliation evidence.

This runbook is an operator guide. Record certification evidence in `docs/superpowers/reports/square-card-on-file-sandbox-certification.md`; do not paste secrets, private connection strings, raw provider payloads, or customer PII into this file, the report, tickets, chat, or shell history.

## Current status

- Current decision: **NO-GO for production card-on-file enablement**.
- Required next step: collect real staging and Square sandbox evidence on `https://preview.lashher.com` or the active Vercel preview/staging URL.
- Local tests and mocked Playwright flows are useful regression checks, but they do not prove live Square sandbox tokenization, Cards API persistence, invoice publishing, webhook delivery, or reconciliation.
- Production `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true` must remain disabled until every required evidence row is complete and approved.

## Non-negotiable safety rules

1. **Use Square sandbox in staging.** Preview/staging must use `SQUARE_ENVIRONMENT=sandbox`; never point the staging deployment at Square production credentials.
2. **Keep production disabled until approval.** Do not set production `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true` before the certification report contains complete passing evidence.
3. **Do not record sensitive values.** Never record raw card tokens, `sourceId` values, verification tokens, access tokens, webhook signature keys, webhook signatures, `DATABASE_URL`, admin setup URLs, full provider payloads, or PII.
4. **Use redacted object references only.** Acceptable examples: `invoice: inv_xxxx…`, `payment: pay_xxxx…`, `card: ccof_xxxx…`, `customer: cust_xxxx…`, `hold: hold_xxxx…`.
5. **Do not use mock payment mode for production proof.** `PAYMENT_GATEWAY_MODE=mock` is acceptable only for explicitly labeled local/dev mock tests and is rejected for production enablement.
6. **Stop on unresolved unsafe states.** Production approval is blocked by unresolved `manual_followup`, stale `charge_pending`, provider mismatch, webhook uncertainty, duplicate-charge risk, or missing Square sandbox evidence.

## Required staging environment

Configure the staging/preview deployment with a migrated private PostgreSQL database and Square sandbox credentials. The active staging preview URL is currently:

```txt
https://preview.lashher.com
```

Required environment variables for the Square card-on-file staging gate:

```txt
SERVICE_BOOKING_SQUARE_ENABLED=true
SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true
PAYMENT_GATEWAY_MODE=live
SQUARE_ENVIRONMENT=sandbox
SQUARE_APPLICATION_ID
SQUARE_ACCESS_TOKEN
SQUARE_LOCATION_ID
SQUARE_WEBHOOK_SIGNATURE_KEY
SQUARE_SERVICE_BOOKING_WEBHOOK_URL
SQUARE_SERVICE_BOOKING_RETURN_URL
BOOKING_ADMIN_PAYMENT_ACTION_SECRET
CRON_SECRET
PAYMENT_RECONCILIATION_CRON_SECRET
DATABASE_URL
```

Expected staging URL values:

```txt
SQUARE_SERVICE_BOOKING_WEBHOOK_URL=https://preview.lashher.com/api/webhooks/square
SQUARE_SERVICE_BOOKING_RETURN_URL=https://preview.lashher.com/api/booking/square/return
```

If Vercel assigns a different preview URL for the active staging branch, use that URL consistently in the Square sandbox webhook subscription, Vercel env vars, and evidence notes.

## Staging preparation sequence

1. Confirm the staging deployment is running the intended branch and commit.
2. Confirm production still has `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED` unset or set to `false`.
3. Confirm preview/staging Sanity uses `NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10` and validate the environment before relying on `npm run build`:

   ```bash
   VERCEL_ENV=preview NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10 node scripts/validate-sanity-env.mjs
   ```

4. Apply the latest private DB migrations to the staging/preview PostgreSQL database.
5. Confirm the staging database contains the card-on-file, policy acceptance, no-show charge, payment event, and appointment hold schema required by the current code.
6. Configure Square Developer Dashboard in **Sandbox** mode:
   - Web Payments SDK application ID.
   - Sandbox access token.
   - Sandbox location ID.
   - Webhook signature key.
   - Webhook endpoint pointed at `/api/webhooks/square` on the active staging URL.
   - Webhook events covering invoice and payment outcomes used by service booking and training invoice flows:
     - `payment.created`
     - `payment.updated`
     - `invoice.created`
     - `invoice.published`
     - `invoice.updated`
     - `invoice.payment_made`
     - `invoice.canceled`
     - `invoice.scheduled_charge_failed`
     - `order.updated`
7. Configure Vercel preview/staging env vars from the secure secret manager. Do not paste the values into docs or chat.
8. Redeploy staging after env changes.
9. Run the env preflight in the staging env context:

   ```bash
   npm run check:square-card-on-file-env
   ```

   Expected result: pass. The script should list missing variable names only on failure and must not print secret values.

## Automated checks to run and record

Run these checks in the staging-relevant context before live Square sandbox certification. Record safe results in `docs/superpowers/reports/square-card-on-file-sandbox-certification.md` with UTC timestamp and database alias only.

```bash
npm run lint
npm run test:unit
npm run build
npx playwright test tests/booking.spec.ts --project=chromium
npx playwright test tests/booking-card-on-file-config.spec.ts --project=chromium
npx tsx --test src/lib/private-db/card-on-file-repository.db.test.ts src/lib/booking/payments/service-reconciliation-monitor.test.ts
```

Evidence to record for each command:

- command name
- pass/fail result
- UTC timestamp
- safe database alias, for DB-backed checks
- short sanitized note for any warning that does not block approval

Do not record DB connection strings, full command wrappers containing secrets, provider payloads, or screenshots with PII.

## Live Square sandbox certification scenarios

Complete every scenario below against the staging deployment and Square sandbox. Record evidence in `docs/superpowers/reports/square-card-on-file-sandbox-certification.md`.

For every row, record only:

- UTC timestamp
- local booking/hold reference
- redacted Square object refs, for example `invoice: inv_xxxx…`
- local DB status after webhook/reconciliation
- operator decision

Do not record raw card tokens, `sourceId`, verification tokens, access tokens, webhook secrets, signatures, full Square object IDs, full webhook payloads, customer names, emails, phone numbers, or cardholder PII.

### 1. Web Payments SDK STORE tokenization

Goal: prove the browser uses Square sandbox Web Payments SDK tokenization before booking confirmation.

Steps:

1. Visit the staging booking flow.
2. Select a service and create a booking hold.
3. Confirm the no-show/cancellation policy checkbox is required before card submission.
4. Confirm the Square sandbox card iframe loads from the sandbox Web Payments script.
5. Submit a Square sandbox card through the card-on-file form.
6. Confirm the booking POST to `/api/booking/card-on-file` receives a source token and optional verification token.

Expected result:

- Square iframe loads in staging.
- The browser receives a sandbox tokenization result.
- `/api/booking/card-on-file` accepts the booking confirmation request.
- No raw token is recorded in evidence.

### 2. Cards API save

Goal: prove the app saves only provider-safe card metadata after Square sandbox card creation.

Steps:

1. Use the successful staging booking from scenario 1.
2. Confirm Square sandbox created or reused the customer record.
3. Confirm Square sandbox created the card-on-file record.
4. Inspect the local private DB record through a safe redacted query or admin view.

Expected result:

- Square sandbox customer/card exist.
- App stores only Square card ID plus brand, last4, and expiry metadata.
- App does not store raw card token, raw source ID, full card payload, PAN, or CVV.

### 3. Draft no-show invoice/order

Goal: prove booking creates a Square order and DRAFT invoice for the authorized no-show amount.

Steps:

1. Use the booked hold with saved card from scenario 1.
2. Confirm the local no-show charge record references redacted Square order and invoice identifiers.
3. Confirm Square sandbox shows an order and DRAFT invoice.
4. Compare the Square draft invoice amount to the local authorized max no-show amount.

Expected result:

- Square order and DRAFT invoice exist.
- Amount equals the authorized max no-show charge amount.
- Local record remains in a safe pre-charge state until admin action and/or webhook finalization.

### 4. Admin exact amount charge

Goal: prove admins can charge only the allowed no-show amount after appointment end time.

Steps:

1. Wait until the sandbox appointment end time has passed or use an approved staging-only appointment time that is already eligible.
2. Read the allowed amount from the booked hold's no-show charge record; do not guess the amount.
3. Call the admin route with the staging admin payment action secret loaded from the secure environment:

   ```bash
   curl --fail-with-body \
     --request POST \
     --header "Authorization: Bearer $BOOKING_ADMIN_PAYMENT_ACTION_SECRET" \
     --header "Content-Type: application/json" \
     --data '{
       "amountCents": 12345,
       "confirmPolicyCharge": true,
       "idempotencyKey": "operator-generated-unique-key",
       "operatorId": "operator-alias",
       "reason": "staging sandbox no-show certification"
     }' \
     "https://preview.lashher.com/api/admin/appointments/<appointment-id>/no-show"
   ```

4. Replace `12345` with the actual `allowedAmountCents` from the local no-show charge record.
5. Replace `<appointment-id>` with the redacted/local appointment reference used in the report.

Expected result:

- Route authorizes with `BOOKING_ADMIN_PAYMENT_ACTION_SECRET`.
- Route rejects mismatched amounts with `NO_SHOW_AMOUNT_MUST_EQUAL_MAX_CHARGE` and returns `allowedAmountCents`.
- Route charges only the exact allowed amount.
- Response is `charged` or `charge_pending` depending on provider timing; `charge_failed` or `manual_followup` requires investigation and blocks approval until resolved.

### 5. Webhook charged finalization

Goal: prove Square webhook delivery finalizes the local no-show charge only after provider invariants pass.

Steps:

1. Confirm Square sandbox emits the expected invoice/payment webhook after the admin charge.
2. Confirm Square sends the event to `https://preview.lashher.com/api/webhooks/square` or the active staging webhook URL.
3. Confirm the webhook is signature-verified and accepted by staging.
4. Confirm the local no-show record becomes `charged`.
5. Confirm a sanitized payment event is recorded idempotently.

Expected result:

- Local no-show record becomes `charged`.
- Sanitized payment event exists.
- Replayed duplicate webhook does not create unsafe duplicate state transitions.
- Evidence contains only redacted event/log references.

### 6. Declined/failed charge

Goal: prove failed Square sandbox charge outcomes are safe and operator-visible.

Steps:

1. Use a separate staging booking and a Square-supported sandbox failure path for the saved-card no-show charge. Prefer a provider-documented sandbox decline/failure trigger. If the sandbox dashboard/API cannot produce a reliable failed payment event, leave this scenario pending and do not approve production.
2. Trigger the eligible admin no-show charge.
3. Observe Square sandbox outcome and staging logs.
4. Inspect the local no-show charge record and sanitized alert evidence.

Expected result:

- Local record becomes `charge_failed` when provider failure is certain.
- Local record remains `charge_pending` only when provider certainty is ambiguous and webhook/reconciliation is expected.
- Alert/manual follow-up behavior is visible to operators.
- No retry with a different idempotency key occurs until provider state is understood.

### 7. Publish timeout recovery

Goal: prove stale `charge_pending` recovery is safe, idempotent, and does not double-charge.

Steps:

1. Use only a dedicated staging record or approved staging DB clone; never manually edit production data for this scenario.
2. Create or identify a test no-show record with `status=charge_pending`, `providerStatus=publish_pending`, valid redacted Square invoice/order references, and `updatedAt` older than 15 minutes. Use 16 minutes or older to avoid boundary ambiguity.
3. Run reconciliation using the protected reconciliation route.
4. Confirm the app checks provider invoice/payment state before retry or manual review.
5. Confirm retry/manual-review behavior preserves idempotency and the original provider references.

Expected result:

- Stale `charge_pending` is surfaced.
- Retry happens only when Square state proves no terminal invoice/payment state advanced.
- Otherwise, operator manual review is required.
- No duplicate charge is created.

### 8. Legacy Payment Link fallback

Goal: prove card-on-file unavailability falls back to legacy Square hosted checkout without losing the hold.

Steps:

1. Disable or make unavailable the card-on-file config in staging or an approved dedicated preview environment.
2. Confirm `/api/booking/square/config` returns unavailable/404 for card-on-file config.
3. Start the booking flow and confirm it falls back to legacy Square hosted checkout.
4. Complete sandbox hosted checkout.
5. Confirm `/api/booking/square/return` and/or `/api/webhooks/square` reconcile the payment safely.

Expected result:

- Hold is not lost when card-on-file config is unavailable.
- Legacy hosted checkout payment can still finalize through verified return/webhook handling.
- Any unmatched legacy payment is routed to safe manual review, not silent success.

### 9. Training Square invoice event

Goal: prove training Square invoice webhooks still finalize correctly before service-booking/no-show fallback handlers.

Steps:

1. In staging, enable the training Square invoice path only if it is intended for the certification run.
2. Complete a training checkout that creates and publishes a Square invoice.
3. Pay the invoice in Square sandbox.
4. Confirm `invoice.payment_made` reaches `/api/webhooks/square`.
5. Confirm the training invoice finalizer processes the event before no-show/service fallback handling.

Expected result:

- Training enrollment finalizes idempotently.
- No-show/service fallback does not incorrectly claim the training invoice event.
- Evidence uses redacted invoice/order/payment references only.

## Reconciliation route and cron validation

Invoke the protected reconciliation endpoint in staging after the live sandbox scenarios. The route is:

```txt
GET /api/admin/payment-reconciliation
```

Use the staging `PAYMENT_RECONCILIATION_CRON_SECRET` bearer token. The route also accepts the generic `CRON_SECRET` only when the route-specific reconciliation secret is configured, but operator/manual validation should prefer the route-specific secret.

Example invocation from a secure shell with secrets already loaded:

```bash
curl --fail-with-body \
  --request GET \
  --header "Authorization: Bearer $PAYMENT_RECONCILIATION_CRON_SECRET" \
  "https://preview.lashher.com/api/admin/payment-reconciliation"
```

Expected result:

- Unauthorized requests return `401`.
- Missing route-specific reconciliation secret disables the route with `404`.
- Authorized staging request returns a JSON summary from the reconciliation monitor.
- The summary is `ok: true`, or every finding is understood, remediated, and recorded.
- There are no unresolved `manual_followup` states.
- There are no unresolved stale `charge_pending` states.
- There is no provider mismatch.

Record a redacted JSON summary or a secure evidence location in `docs/superpowers/reports/square-card-on-file-sandbox-certification.md`. Do not paste secrets, full webhook payloads, or PII.

## Certification report approval rules

The certification report is the source of truth for the card-on-file production gate:

```txt
docs/superpowers/reports/square-card-on-file-sandbox-certification.md
```

The report can switch to production approval only when all of these are true:

- `npm run check:square-card-on-file-env` passes in staging context.
- All automated checks are recorded with safe pass evidence.
- Every live Square sandbox scenario has concrete staging evidence.
- Webhook delivery is proven against staging.
- Reconciliation route is invoked and has no unresolved unsafe findings.
- No required evidence row is pending, skipped, or failed.
- No unresolved `manual_followup`, stale `charge_pending`, provider mismatch, or duplicate-charge risk remains.
- Operator and reviewer have approved the report.

Until all approval criteria pass, the final report line must remain exactly:

```md
Decision: Do not enable production. Reason: one or more required sandbox/staging rows remain pending or failed.
```

Only after all criteria pass, update the final report line to exactly:

```md
Decision: Approved for production enablement. Reason: all required automated, DB-backed, Square sandbox, staging webhook, and reconciliation checks passed with no unresolved manual-followup states.
```

## Production enablement after approval only

Production enablement is a separate controlled cutover after the certification report is approved.

After approval, during the controlled production cutover:

1. Confirm the approved report line is present.
2. Confirm production uses the intended branch/commit.
3. Confirm production private DB migrations are complete.
4. Confirm production `PAYMENT_GATEWAY_MODE` is not `mock`.
5. Confirm production Square Developer Dashboard is in **Production** mode.
6. Confirm production webhook subscription points at:

   ```txt
   https://<production-domain>/api/webhooks/square
   ```

7. Confirm production webhook subscriptions include invoice/payment events required by service booking, no-show charges, and training invoice handling.
   - `payment.created`
   - `payment.updated`
   - `invoice.created`
   - `invoice.published`
   - `invoice.updated`
   - `invoice.payment_made`
   - `invoice.canceled`
   - `invoice.scheduled_charge_failed`
   - `order.updated`
8. Configure production Square credentials through the secure secret manager only.
9. Set production values:

   ```txt
   SERVICE_BOOKING_SQUARE_ENABLED=true
   SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true
   PAYMENT_GATEWAY_MODE=live
   SQUARE_ENVIRONMENT=production
   SQUARE_APPLICATION_ID
   SQUARE_ACCESS_TOKEN
   SQUARE_LOCATION_ID
   SQUARE_WEBHOOK_SIGNATURE_KEY
   SQUARE_SERVICE_BOOKING_WEBHOOK_URL
   SQUARE_SERVICE_BOOKING_RETURN_URL
   BOOKING_ADMIN_PAYMENT_ACTION_SECRET
   CRON_SECRET
   PAYMENT_RECONCILIATION_CRON_SECRET
   DATABASE_URL
   ```

10. Run the env preflight in production env context to validate the card-on-file environment:

    ```bash
    npm run check:square-card-on-file-env
    ```

11. Confirm `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED` remains `true` after the preflight passes.

12. Redeploy production.

If production env validation fails, disable the card-on-file flag until the env context is fixed. Fix the production env context through the secure dashboard/secret manager, rerun validation, and record only safe pass/fail output.

## First live booking monitoring

For the first live production booking after card-on-file enablement:

1. Monitor `/api/booking/square/config` availability.
2. Monitor `/api/booking/card-on-file` booking confirmation.
3. Confirm saved card metadata contains only provider card ID, brand, last4, and expiry.
4. Confirm policy acceptance and no-show charge records persist.
5. Confirm Google Calendar event creation happens only after secure card save and local persistence.
6. Monitor `/api/webhooks/square` for relevant invoice/payment events.
7. Run or observe `/api/admin/payment-reconciliation` after the first live flow.
8. Confirm no unresolved `manual_followup`, stale `charge_pending`, provider mismatch, or duplicate event issue appears.
9. If any unsafe state appears, disable `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED`, preserve evidence, and follow the manual review runbook before retrying.

## Safe evidence and redaction appendix

Safe to record:

- UTC timestamps.
- Command names and pass/fail result.
- Redacted local references such as `hold: hold_xxxx…`.
- Redacted Square references such as `invoice: inv_xxxx…`, `payment: pay_xxxx…`, `card: ccof_xxxx…`, `customer: cust_xxxx…`.
- Sanitized Vercel log/event IDs.
- Local DB status names such as `booked`, `provider_draft_created`, `charged`, `charge_failed`, `charge_pending`, and `manual_followup`.
- Operator decision: pass, no-go, resolved, or needs manual follow-up.

Never record:

- Raw card token.
- `sourceId`.
- Verification token.
- Access token.
- Webhook signature key.
- Webhook signature header.
- `DATABASE_URL`.
- Admin setup URL.
- Full Square customer/card/payment/invoice object payloads.
- Customer name, email, phone, address, or cardholder PII.
- Full card number, CVV, or unredacted expiry if attached to PII.

Recommended evidence row shape:

```md
| Scenario       | UTC timestamp        | Local reference  | Redacted Square refs                   | Local DB status                        | Operator decision |
| -------------- | -------------------- | ---------------- | -------------------------------------- | -------------------------------------- | ----------------- |
| Cards API save | 2026-06-29T00:00:00Z | hold: hold_xxxx… | customer: cust_xxxx…, card: ccof_xxxx… | booked; no_show=provider_draft_created | pass              |
```

## Operator checklist

- [ ] Production card-on-file flag confirmed disabled before staging work begins.
- [ ] Staging private PostgreSQL DB migrated.
- [ ] Staging Square sandbox credentials configured.
- [ ] Staging webhook points at `/api/webhooks/square` on the active staging URL.
- [ ] Staging return URL points at `/api/booking/square/return` on the active staging URL.
- [ ] `npm run check:square-card-on-file-env` passes in staging context.
- [ ] Automated checks pass and are recorded safely.
- [ ] All nine live Square sandbox scenarios pass with safe evidence.
- [ ] Reconciliation endpoint authorizes and returns no unresolved unsafe findings.
- [ ] Certification report has approved final decision line.
- [ ] Production Square credentials and webhooks are configured only after approval.
- [ ] Production env preflight passes after setting the approved card-on-file env context and before cutover is considered complete.
- [ ] First live booking is monitored through saved card, webhook, and reconciliation.
