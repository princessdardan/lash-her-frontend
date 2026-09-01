# Square Service Booking Setup

Last verified: 2026-08-31

The current public service-booking payment path is Square direct charge-and-store. The customer stays in the Lash Her app, Square Web Payments tokenizes the card with `intent: "CHARGE_AND_STORE"`, and the server authorizes then captures payment through `POST /api/booking/payment/confirm`. A successful response reports `paymentStatus: "captured"`.

The current public UI does not create Square Payment Links or redirect to Square hosted checkout. The hosted return/webhook finalizer remains for historical records. `POST /api/booking/checkout` is a noncanonical compatibility endpoint that the current UI does not call, but it remains technically capable of creating a Payment Link from a valid active hold. Operators must not invoke it for a new booking; code removal or a gate is required to make the historical-only boundary enforceable.

## Current endpoints

| Responsibility                                        | Endpoint                                    |
| ----------------------------------------------------- | ------------------------------------------- |
| Opaque hold/payment handoff                           | `POST /api/booking/holds`                   |
| Browser-safe Square SDK config                        | `GET /api/booking/square/config`            |
| Direct payment confirmation                           | `POST /api/booking/payment/confirm`         |
| Noncanonical hosted-checkout compatibility capability | `POST /api/booking/checkout`                |
| Shared signed Square webhook                          | `POST /api/webhooks/square`                 |
| Payment/booking reconciliation                        | `GET /api/admin/payment-reconciliation`     |
| Authorized no-show action                             | `POST /api/admin/appointments/[id]/no-show` |
| Historical hosted return                              | `GET /api/booking/square/return`            |

## Provider boundary

| Flow                       | Square behavior                                                                                                                            | Local authority                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Service booking            | Web Payments `CHARGE_AND_STORE`; Payments authorization/capture; Customers and Cards; optional draft no-show invoice for an unpaid balance | PostgreSQL hold, resource reservations, captured-payment evidence, saved-card/policy/no-show records, appointment, and Calendar projection state |
| Product checkout           | Web Payments one-time charge when `SQUARE_COMMERCE_ENABLED=true`                                                                           | PostgreSQL order, stock/payment obligations, transaction and fulfillment state                                                                   |
| Primary training checkout  | Web Payments one-time charge when `SQUARE_COMMERCE_ENABLED=true`                                                                           | PostgreSQL order, paid enrollment, and scheduling-token state                                                                                    |
| Optional training Afterpay | Square Invoice when `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`                                                                        | PostgreSQL order/enrollment; webhook-verified paid state                                                                                         |

All flows share the credentials for one target Square application/location and the single webhook at `/api/webhooks/square`. The handler routes each verified event to the matching service, commerce, training-invoice, no-show, refund, or historical reconciliation path.

Square is provider evidence, not the sole booking authority. A captured service payment is persisted before appointment/Calendar projection. If projection cannot complete, the record stays in an explicit reconciliation or manual-follow-up state; it must not be charged again merely because the Calendar event is missing.

## Required Square capabilities

The access token used by the app must support the APIs exercised by the enabled flows:

| API       | Current use                                                                                  |
| --------- | -------------------------------------------------------------------------------------------- |
| Payments  | Authorize, capture, cancel, retrieve/list, and refund payments                               |
| Customers | Create or reuse the Square customer for service booking                                      |
| Cards     | Save the verified card for permitted no-show enforcement                                     |
| Orders    | Create the order backing a remaining-balance/no-show invoice and reconcile historical orders |
| Invoices  | Create/read/publish the draft no-show invoice; optional training Afterpay invoice            |
| Team      | Discover/verify Square team members for provider sales attribution                           |

If the application uses Square OAuth rather than a personal access token, grant the Square permissions required by those API operations, including read access for Team API discovery. Keep permissions no broader than the enabled features, but do not remove a capability while active records still require reconciliation or no-show processing.

The code currently sends Square API version `2026-05-20`.

## Environment variables

Use the maintained block in `.env.local.example`. A staging direct-payment setup has this shape:

```env
DATABASE_URL=<private-postgres-url>
SERVICE_BOOKING_MODEL_MODE=operational

SERVICE_BOOKING_SQUARE_ENABLED=true
SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true
PAYMENT_GATEWAY_MODE=live

SQUARE_ENVIRONMENT=sandbox
SQUARE_ACCESS_TOKEN=<sandbox-access-token>
SQUARE_APPLICATION_ID=<sandbox-application-id>
SQUARE_LOCATION_ID=<sandbox-location-id>
SQUARE_WEBHOOK_SIGNATURE_KEY=<sandbox-webhook-signature-key>
SQUARE_SERVICE_BOOKING_WEBHOOK_URL=https://<staging-domain>/api/webhooks/square
SQUARE_SERVICE_BOOKING_RETURN_URL=https://<staging-domain>/api/booking/square/return

PAYMENT_RECONCILIATION_CRON_SECRET=<route-specific-secret>
CRON_SECRET=<vercel-cron-secret>
BOOKING_ADMIN_PAYMENT_ACTION_SECRET=<staff-payment-action-secret>
```

Important boundaries:

- `SQUARE_ACCESS_TOKEN` and `SQUARE_WEBHOOK_SIGNATURE_KEY` are secrets. Never expose them with `NEXT_PUBLIC_`.
- `SQUARE_APPLICATION_ID` and `SQUARE_LOCATION_ID` are returned by the server's browser-safe config route; the application ID is not an access token.
- Both service flags must be exactly `true` for the current public payment form. Missing required config, including `DATABASE_URL`, makes the browser-safe config unavailable. That config check does not validate database reachability; session/confirmation database failures surface later and still fail the customer flow closed.
- `SQUARE_SERVICE_BOOKING_RETURN_URL` is still required by the shared service Square environment loader because historical hosted records can return through that endpoint. It is not the destination of a current direct payment.
- `SQUARE_SERVICE_BOOKING_WEBHOOK_URL` must exactly equal the Square subscription notification URL. Square signs the notification URL plus the raw body; even a domain/path mismatch causes every signature check to fail.
- `PAYMENT_RECONCILIATION_CRON_SECRET` must be configured to enable the reconciliation route. The scheduled call may also use `CRON_SECRET` only when the route-specific secret exists.
- `BOOKING_ADMIN_PAYMENT_ACTION_SECRET` protects the no-show action and must be distinct from cron and setup secrets.
- `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_LOCAL_INVOICE_FALLBACK_ENABLED` is a local/sandbox compatibility switch for the older card-on-file endpoint. Leave it `false` for the direct payment path; production ignores it.

Use `SQUARE_ENVIRONMENT=sandbox` with Sandbox credentials for local/preview/staging and `SQUARE_ENVIRONMENT=production` with Production credentials only in production. Never mix an application ID, access token, location, or webhook signature key from different applications or environments.

## Obtain Square values

In the Square Developer Console for the target application/environment:

1. Copy the access token and application ID from **Credentials**.
2. Copy the intended location ID from the same environment.
3. Confirm the location is the one used for service sales and team attribution.
4. In `/admin/staff?tab=square`, refresh Square team members and map each active provider to the correct location member.
5. In `/admin/integrations`, enable required attribution only after every active offering provider shows a verified active mapping.
6. Keep sandbox and production values in separate deployment scopes.

An operational hold fails closed when required Square team attribution is absent or no longer valid. Do not bypass that check by accepting a team-member ID from the browser.

## Create the shared webhook subscription

Create one subscription per reachable deployment environment:

```text
https://<domain>/api/webhooks/square
```

Subscribe to the event types consumed by the current handler and enabled workflows:

- `payment.created`
- `payment.updated`
- `order.updated`
- `invoice.payment_made`
- `refund.created`
- `refund.updated`

`payment.created` and `payment.updated` are the direct-payment observation/reconciliation backstop and no-show payment events. `order.updated` supports order-side and historical hosted reconciliation. `invoice.payment_made` finalizes no-show/training invoice outcomes. Refund events persist and reconcile refund results.

After saving the subscription:

1. Copy its signature key into `SQUARE_WEBHOOK_SIGNATURE_KEY` for the same environment.
2. Copy the notification URL byte-for-byte into `SQUARE_SERVICE_BOOKING_WEBHOOK_URL`.
3. Redeploy/restart the app.
4. Send a Square test event already included in the subscription.

Expected route behavior:

- Missing/invalid signature: `401`.
- Malformed signed payload: `400`.
- Body over the 64 KB limit: `413` before signature work.
- Retryable persistence/provider failure: `503`, so Square can retry.
- Verified processed, duplicate, or safely ignored event: `200`.

Do not use a browser return, query value, or webhook delivery alone as proof of payment. The finalizers look up and verify provider/local amount, currency, customer/reference, order/payment identity, and team attribution as appropriate.

## Direct charge-and-store lifecycle

1. `/api/booking/holds` revalidates the operational offering and resource availability, creates a ten-minute private hold/reservation set, and returns only an opaque payment-session URL.
2. The payment page collects the customer, deposit/full/custom partial selection, policy acceptance, marketing choice, and Square card entry.
3. Square Web Payments tokenizes with `CHARGE_AND_STORE`, customer initiated, CAD, and the selected amount.
4. `/api/booking/payment/confirm` resolves the opaque session, recomputes allowed amounts from trusted offering/payment snapshots, and creates/reuses the Square customer.
5. Before payment creation, the server claims a durable request intent and capture lease. Retries reuse provider idempotency state; a changed request cannot reuse an ambiguous old provider intent.
6. Square authorizes the payment without treating the initial response as final capture. The app saves the verified card and persists policy/no-show evidence.
7. For a partial/deposit payment, the app creates a Square DRAFT invoice for the permitted remaining no-show balance. A full payment has no remaining-balance invoice requirement.
8. The server persists the Square authorization, revalidates the capture lease/reservations, and completes the Square payment.
9. `COMPLETED` provider evidence is persisted before creating the authoritative appointment and Google Calendar event.
10. The response returns `paymentStatus: "captured"` with `bookingStatus: "booked"` or `"manual_followup"`.

Never log or store the PAN, CVV, raw Square source token, verification token, raw payment-session reference, or full webhook body. The browser card fields remain in Square's iframe.

## Local and staging verification

`PAYMENT_GATEWAY_MODE=mock` is useful for focused compatibility/unit tests, but it does not emulate the current browser-to-`/api/booking/payment/confirm` lifecycle end to end. The active public config and direct clients still require coherent Square configuration. Use Square Sandbox for the real flow.

For a complete webhook test, use a deployed preview/staging origin or an HTTPS tunnel whose URL is configured in both Square and the environment. When a tunnel hostname rotates, update both `SQUARE_SERVICE_BOOKING_WEBHOOK_URL` and the Square subscription before retesting.

Run the source-controlled preflight with the target variables loaded:

```bash
npm run check:square-card-on-file-env
```

The preflight checks both flags, required credentials/secrets/database values, Square environment alignment, production mock rejection, and HTTPS webhook/return URLs. It reports variable names, not values.

Run focused automated coverage:

```bash
npx tsx --test src/lib/booking/payments/service-charge-and-store.test.ts
npx tsx --test src/app/api/booking/payment/confirm/route.test.ts
npx tsx --test src/app/api/webhooks/square/route.test.ts
npx playwright test tests/booking-card-on-file-config.spec.ts --project=chromium
npx playwright test tests/service-booking-payment-page.spec.ts --project=chromium
```

With a protected `TEST_DATABASE_URL`, include the DB-backed appointment-finalization coverage:

```bash
npx tsx --test src/lib/private-db/appointment-finalization-repository.db.test.ts
```

Then complete this Square Sandbox smoke matrix in staging:

- Successful deposit/partial and full payment; response is captured and exactly one appointment/event exists.
- Declined authorization; no booked appointment or Calendar event.
- Card-save or draft-invoice failure; authorization is cancelled/contained and booking is not reported successful.
- Connection loss after Square accepts payment creation; same request resumes with the durable provider intent and does not double-charge.
- Duplicate submit, webhook, and reconciliation calls; no duplicate payment, saved card, no-show record, appointment, or Calendar event.
- Provider `COMPLETED` with local projection failure; record moves to manual/rebooking follow-up and no automatic second charge occurs.
- Public Square config disabled; new payment UI fails closed and does not call historical hosted checkout.
- A pre-existing historical hosted record can still be reconciled by return/webhook/server lookup while direct payment remains disabled.

Use redacted internal references and UTC timestamps as evidence. Do not copy credentials, customer PII, full Square IDs, raw tokens, or webhook bodies into release notes.

## No-show workflow

The direct booking flow stores explicit policy acceptance, a saved Square card reference, and a no-show record. If a balance remains, it also prepares a DRAFT Square invoice.

Only an authorized staff operation may call `POST /api/admin/appointments/[id]/no-show`. The appointment must have ended, the operator and reason are audited, `confirmPolicyCharge` must be true, and the requested amount must equal the stored allowed amount. The route is protected by `BOOKING_ADMIN_PAYMENT_ACTION_SECRET` and uses an idempotency key.

Do not retry with a different idempotency key while a charge is pending or ambiguous. Check `/admin/appointments`, `/admin/booking-issues`, Square, webhook observations, and `/api/admin/payment-reconciliation` first.

## Production enablement and emergency stop

Before enabling production:

1. Apply/check the complete private DB migration lineage.
2. Prove the direct lifecycle with Square Sandbox in staging.
3. Create the Production webhook subscription and verify its signature.
4. Confirm provider/team mappings use Production location members.
5. Load only Production Square credentials into the Production deployment scope.
6. Run `npm run check:square-card-on-file-env`, deploy, and run a controlled low-risk smoke approved by the business owner.
7. Confirm the reconciliation cron remains scheduled every 30 minutes in `vercel.json` and returns a healthy result.

To stop new service card collection without discarding recovery capability, set:

```env
SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=false
```

Leave `SERVICE_BOOKING_SQUARE_ENABLED=true`, valid provider credentials, and the webhook/reconciliation secrets in place so captured/ambiguous direct attempts, historical hosted records, refunds, and no-show state can still reconcile. The public config returns unavailable and new payment sessions fail closed; no hosted fallback is created.

Disable `SERVICE_BOOKING_SQUARE_ENABLED` only for a broader incident response that explicitly accepts loss of service-payment confirmation/reconciliation until it is restored. Product/training Square commerce is independently gated by `SQUARE_COMMERCE_ENABLED` but shares the webhook and credentials, so evaluate those flows before changing shared Square values.

For optional training Afterpay Invoice setup, see `docs/training-afterpay-square-invoice.md`.
