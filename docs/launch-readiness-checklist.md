# Launch Readiness Checklist

This checklist must be completed and recorded for both Staging and Production environments before declaring a release "Ready".

## Environment Validation

- [ ] `NEXT_PUBLIC_SANITY_PROJECT_ID` matches `3auncj84`.
- [ ] `NEXT_PUBLIC_SANITY_DATASET` matches target (`staging-2026-05-10` or `production`).
- [ ] `NEXT_PUBLIC_SANITY_API_VERSION` is `2026-03-24`; `SANITY_API_READ_TOKEN` and `SANITY_WRITE_TOKEN` are configured server-side.
- [ ] `SANITY_WEBHOOK_SECRET` is configured and matches the Sanity webhook panel.
- [ ] `DATABASE_URL` is the verified pooled PostgreSQL target and `npm run db:check` exits zero against it.
- [ ] `KV_REST_API_URL` and `KV_REST_API_TOKEN` are valid; booking locks, rate limits, idempotency, and one-time Calendar OAuth state can be written and consumed.
- [ ] `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, and `ADMIN_OWNER_EMAILS` are configured; an authorized owner can sign in to `/admin` and an unlisted account is denied.
- [ ] `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` match the environment OAuth client. Connect and assign calendars through `/admin/calendar-connections` (or employee self-service `/admin/my-calendar`) and verify the actor/resource-bound OAuth state is one-time and returns to the fixed Admin path.
- [ ] `BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY` is a base64-encoded 32-byte server-only key and a connected Google refresh token can be decrypted after a fresh process start.
- [ ] `BOOKING_ADMIN_SETUP_SECRET` remains server-only for the protected legacy/internal bootstrap endpoint. Do not publish, share, or use a secret-bearing setup URL as the normal Admin OAuth flow.
- [ ] `CHECKOUT_SECRET_ENCRYPTION_KEY` is configured as a base64-encoded 32-byte server-only secret.
- [ ] `SERVICE_BOOKING_MODEL_MODE=operational` is set after the operational cutover gate has passed. New public service-booking configuration comes from PostgreSQL; legacy Sanity V1 data remains reconciliation-only.
- [ ] `PAYMENT_GATEWAY_MODE=live` in production. `mock` is limited to local/preview test flows and is rejected for a production deployment.
- [ ] `SQUARE_COMMERCE_ENABLED=true` is set only when Square-backed product and training checkout is intended; otherwise it is unset or `false`. When enabled, the shared Square values (`SQUARE_ENVIRONMENT`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`) and the public-safe `SQUARE_APPLICATION_ID` for the Web Payments SDK config route are configured, and Square events are delivered to `/api/webhooks/square`.
- [ ] `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true` is set only when the optional training Afterpay Square Invoice flow is intended; otherwise it is unset or `false`.
- [ ] If `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true` for production, Square merchant eligibility for live CAD invoices is verified and recorded.
- [ ] For live service booking, both `SERVICE_BOOKING_SQUARE_ENABLED=true` and `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true` are set. The customer flow tokenizes with Square Web Payments SDK intent `CHARGE_AND_STORE` and confirms through `/api/booking/payment/confirm`. Disabling direct card-on-file payment fails new payment sessions closed; it does not create a new hosted Payment Link.
- [ ] Service booking has `SQUARE_ENVIRONMENT`, `SQUARE_ACCESS_TOKEN`, `SQUARE_APPLICATION_ID`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_SERVICE_BOOKING_RETURN_URL`, and `SQUARE_SERVICE_BOOKING_WEBHOOK_URL` configured. The return URL remains for historical hosted-payment reconciliation; new bookings use direct charge-and-store. `SQUARE_APPLICATION_ID` is public-safe, not secret.
- [ ] `BOOKING_ADMIN_PAYMENT_ACTION_SECRET` is configured server-side for the protected no-show payment action.
- [ ] `PAYMENT_RECONCILIATION_CRON_SECRET` is configured and is required to enable the payment reconciliation route; it is distinct from the generic `CRON_SECRET` used by Vercel scheduled cron. The route accepts either bearer when both secrets are configured, but the route-specific secret must be present for the route to be enabled or for manual/staff checks.
- [ ] If `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`, the code-required Square environment values are configured: `SQUARE_ENVIRONMENT`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, and `SQUARE_SERVICE_BOOKING_WEBHOOK_URL`. The shared `SQUARE_SERVICE_BOOKING_WEBHOOK_URL` is the endpoint Square delivers to for service booking, no-show, and training invoice events. Training Square Invoice alone does not require `SQUARE_SERVICE_BOOKING_RETURN_URL` or `SQUARE_APPLICATION_ID`.
- [ ] `CRON_SECRET` is configured for Vercel scheduled requests. `RESEND_MARKETING_SYNC_CRON_SECRET` is also configured so `/api/admin/marketing-contact-sync` is enabled; `CRON_SECRET` is accepted there only after the route-specific secret exists.
- [ ] `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_SEGMENT_MARKETING_ID`, `FROM_EMAIL`, and `ADMIN_EMAIL` are configured.
- [ ] `BACKUP_RETENTION_DAYS` is an integer from 0 through 30. If `BACKUP_VALIDATION_ENABLED=true`, the GCS bucket and isolated restore-database values required by `src/lib/backup-validation/config.ts` are configured and verified. The route is only a safety/configuration scaffold and always requires an external restore runner; a `200` response is not restore evidence.
- [ ] When Chit Chats shipping is enabled, `CHITCHATS_REGION` is exactly one of `british_columbia`, `alberta_saskatchewan`, `ontario_manitoba`, `quebec`, or `atlantic`, and matches the account identified by the target `CHITCHATS_ENVIRONMENT` and `CHITCHATS_CLIENT_ID`.
- [ ] No deployed configuration or readiness check depends on `CHITCHATS_BRANCH_ID`. `CHITCHATS_REGION` is source-controlled environment configuration, while the physical intake location is an external Chit Chats account/business fact that must be verified against the live account; there is no source-controlled intake-location constant.
- [ ] When U.S. shipping or manual pickup is intended, `CHITCHATS_US_SHIPPING_ENABLED` / `MANUAL_PRODUCT_CHECKOUT_ENABLED` are set **and** their source config (`PRODUCT_SHIPPING_US_DDU_CONTRACT` / `PRODUCT_MANUAL_CANCELLATION_POLICY`) is populated and business-confirmed. Setting the flag without the config leaves the feature blocked by design.
- [ ] `VERCEL_ENV=preview node scripts/validate-sanity-env.mjs` passes for staging variables.
- [ ] `VERCEL_ENV=production node scripts/validate-sanity-env.mjs` passes for production variables.
- [ ] `npm run check:square-card-on-file-env` passes when Square service booking/card-on-file is enabled.

## Private Database Migration Readiness

Use `docs/private-database-migration-runbook.md` for the complete migration procedure and evidence template.

- [ ] Staging database identity is manually verified and recorded.
- [ ] Production database identity is manually verified and recorded.
- [ ] Backup and PITR capability is verified for the production target.
- [ ] The migration range `0062` through `0075` has been reviewed as a single production rollout. It contains multiple irreversible drops: shipping attestations/policies/funding state (`0062`–`0066`), retired Helcim columns (`0068`), package capacity (`0070`), shipping-case references (`0074`), and the retired fulfillment policy/risk subsystem (`0075`). Not every migration in the range is destructive, but all affected rows must be snapshotted and checked for audit/retention obligations before the range is applied.
- [ ] Migration approver is assigned and aware of the migration window.
- [ ] Migration evidence template is ready for recording the run.
- [ ] Run `npm run db:check` against staging and production before migration. If migrations are pending, its non-zero `PENDING` result must list only the reviewed range; any `LINEAGE PROBLEM`, unknown hash, duplicate timestamp, or required gap is a stop condition. After migration, run it again and require exit zero through the final journal entry. A timestamp-only query is insufficient.
- [ ] Staging migration uses `PRIVATE_DB_MIGRATION_TARGET=staging` and an exact `PRIVATE_DB_MIGRATION_HOST=<verified-staging-host>` with `npm run db:migrate`.
- [ ] Production migration uses `PRIVATE_DB_MIGRATION_TARGET=production`, exact `PRIVATE_DB_MIGRATION_HOST=<verified-production-host>`, and `PRIVATE_DB_MIGRATION_CONFIRM=production` with `npm run db:migrate`. The command is not run until backup/PITR and approver checks pass.
- [ ] CI passed both zero-to-latest and data-bearing 0033-to-latest migration jobs, including legacy duplicate Helcim-identity quarantine assertions.
- [ ] Staging smoke tests pass with the latest database schema.
- [ ] Retention and redaction owner is identified.
- [ ] Shared private PII tables are present for checkout orders, payment events, appointment holds, training enrollments, marketing contacts, contact submissions, and consent events.
- [ ] Backfill dry-run/execute evidence template, provenance fields, duplicate protection, and stop conditions are ready before any backfill command is approved.
- [ ] Sanity submission source retention/redaction owner decision is identified before historical submission records are imported, hidden, redacted, or deleted.
- [ ] Charge-and-store DB integrity is verified: latest private DB migrations are applied and `npx tsx --test src/lib/private-db/card-on-file-repository.db.test.ts src/lib/private-db/appointment-finalization-repository.db.test.ts src/lib/booking/payments/service-reconciliation-monitor.test.ts` passes against staging. Load `TEST_DATABASE_URL` from a protected env file or session; do not paste the connection string into shell history or an inline placeholder.

## Verification Commands

Run these from the repository root against the intended checkout and record the results. `npm run test:unit` deliberately excludes DB tests; DB coverage is a separate gate.

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm run test:unit`
- [ ] `npm run test:unit:db` with protected `TEST_DATABASE_URL`
- [ ] `npm run test:coverage:critical` with protected `TEST_DATABASE_URL`
- [ ] `npm test`
- [ ] `npm run test:browser:verify` after the required Playwright scenarios complete without skips

## CMS Smoke Matrix

For each document type, verify the publish flow: Update content in Studio -> Publish -> Verify Webhook -> Verify Public Page.

| Environment | Dataset | Document Type          | Test Edit | Webhook Status | Cache Tag | Public/runtime surface | Result |
| ----------- | ------- | ---------------------- | --------- | -------------- | --------- | ---------------------- | ------ |
|             |         | `homePage`             |           |                | `homePage` | `/` |        |
|             |         | `contactPage`          |           |                | `contactPage` | `/contact` |        |
|             |         | `galleryPage`          |           |                | `galleryPage` | `/gallery` |        |
|             |         | `trainingPage`         |           |                | `trainingPage` | Tag/log verification; `/training` redirects to `/training-programs` |        |
|             |         | `trainingProgramsPage` |           |                | `trainingProgramsPage` | `/training-programs` |        |
|             |         | `trainingProgram`      |           |                | `trainingProgram` | `/`, `/training-programs`, `/training-programs/[slug]`, checkout reads |        |
|             |         | `productsPage`         |           |                | `productsPage` | `/products` editorial shell |        |
|             |         | `productCollection`    |           |                | `productCollection` | `/products` collection presentation |        |
|             |         | `promotionCode`        |           |                | `promotionCode` | Product/training promotion validation |        |
|             |         | `policyPage`           |           |                | `policyPage` | `/policies/[slug]` and checkout policy reads |        |
|             |         | `product`              |           |                | `product` | `/products`, `/products/[slug]`, checkout, stock synchronization |        |
|             |         | `service`              |           |                | `service` | `/services/[slug]` editorial/media/SEO only |        |
|             |         | `globalSettings`       |           |                | `global` | Header, footer, popup, metadata |        |
|             |         | `mainMenu`             |           |                | `menu` | Navigation |        |

`bookingSettings` is not an active schema or Studio type. Any surviving document and the `bookingSettings` cache tag are legacy V1 compatibility only. Operational service-booking settings, offerings, intake content, availability, and state are PostgreSQL-owned.

The `/api/revalidate` webhook filter and `{ _id, _type }` projection must match the active type list in `docs/sanity-staging-production-workflow.md`. Verify `TYPE_TAG_MAP` in `src/app/api/revalidate/handler.ts` remains aligned with loader tags in `src/data/loaders.ts`. A product publish must also reconcile its Sanity stock set-point to PostgreSQL, either through the revalidation handler's after-response fold-in or an intentionally configured `/api/webhooks/sanity/inventory-sync` webhook.

## Service Integration Checks

- [ ] **Admin operational readiness:** In `/admin/setup`, confirm booking health is ready. Verify PostgreSQL-backed settings and active records in `/admin/booking-settings`, `/admin/staff`, `/admin/offerings`, `/admin/schedules`, and `/admin/calendar-connections`.
- [ ] **Calendar OAuth:** Follow `docs/google-calendar-oauth-env-setup.md`. From `/admin/calendar-connections`, connect the staging Google account and assign one active booking destination plus any intended busy calendars. Confirm the callback returns to Admin, the one-time OAuth state cannot be reused, and `/admin/setup` reports the provider ready.
- [ ] **Booking:** Visit `/services/[slug]/booking` for an active operational offering and confirm slots load from its assigned Google Calendar resources. Confirm `/booking` only redirects to an active operational offering and does not act as a Sanity settings page.
- [ ] **Paid service booking:** Create a PostgreSQL-backed hold, accept the no-show/cancellation policy, select deposit/full/custom partial where allowed, and complete Square Web Payments SDK tokenization with intent `CHARGE_AND_STORE` through `/api/booking/payment/confirm`. Confirm capture/card persistence precedes authoritative appointment finalization and Google Calendar projection.
- [ ] **Fail-closed payment gate:** With direct card-on-file payment disabled or unavailable, confirm a new payment session does not create or redirect to a Square hosted Payment Link. Historical hosted-payment return/webhook records remain reconcilable only. Confirm direct `/api/booking/create` requests reject with the secure-payment-required error.
- [ ] **Checkout:** Add product to cart, proceed to the Square card checkout (Web Payments SDK), and complete a paid order with a Square sandbox card; confirm the charge captures and the private order/confirmation state is persisted.
- [ ] **Training checkout:** Complete a paid training checkout through the Square card flow (Web Payments SDK). If `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`, also verify the Square invoice path creates and publishes a Square invoice, that `invoice.payment_made` reaches the training Square Invoice finalizer before other Square-event routing, and that the enrollment is finalized idempotently.
- [ ] **Forms:** Submit general inquiry, training contact, and contact popup tests; confirm private DB submission/consent evidence and Resend email delivery with PII redacted in evidence.
- [ ] **Booking Marketing Choices:** Create one booking with marketing opt-in and one without; confirm both choices create private DB audit evidence, only affirmative consent updates the consolidated marketing contact, and no new Sanity submission documents are created.

## Service Booking Charge-and-Store Smoke Tests

Run these when both service-booking Square flags are `true` in the target environment. Use Square sandbox for staging, follow **Local and staging verification** in `docs/square-service-booking-setup.md`, run `npm run check:square-card-on-file-env` first, and store redacted evidence with the release record. Do not use archived STORE-only certification reports as current evidence.

- [ ] **Policy blocks confirmation:** Confirm the card-on-file form cannot be submitted while the no-show/cancellation policy checkbox is unchecked.
- [ ] **Sandbox charge-and-store succeeds:** Confirm the browser tokenizes with `verificationDetails.intent = "CHARGE_AND_STORE"`, `/api/booking/payment/confirm` charges the selected HST-inclusive amount, stores the card for policy-authorized no-show use, and returns only allowed card metadata to the browser.
- [ ] **Failed payment/card persistence does not confirm booking:** Simulate the relevant Square failures and confirm the hold is not falsely marked `booked`, no duplicate Google Calendar event is created, and the durable payment attempt reaches the expected retry/manual-follow-up state.
- [ ] **Booked appointment has required records:** Confirm a successful flow has immutable hold/pricing evidence, captured payment evidence, saved-card reference, policy acceptance, no-show charge record, authoritative operational appointment, and exactly one Google Calendar event.
- [ ] **Admin no-show charge succeeds:** Call `POST /api/admin/appointments/[id]/no-show` with a valid `BOOKING_ADMIN_PAYMENT_ACTION_SECRET` bearer token and a request body of `{ amountCents: <appointment-max-charge-cents>, confirmPolicyCharge: true, idempotencyKey: "<unique-key>", operatorId: "<operator-alias>", reason: "<concise-reason>" }`. Confirm the amount equals the appointment max charge and the no-show charge succeeds against the saved card.
- [ ] **Declined no-show charge records failure:** Simulate a declined no-show charge and confirm the local no-show charge record enters `charge_failed` state and emits the structured service-payment alert log. If paging or notification is required, separately verify the external monitoring rule routes that log; the repository does not provision alert delivery.
- [ ] **Legacy Payment Link reconciliation:** Confirm pre-existing legacy Square Payment Link payments still reconcile through `/api/booking/square/return` and `/api/webhooks/square`, or route to manual review if they cannot be matched. Do not create a new hosted link as fallback.

## Square charge-and-store production enablement gate

- [ ] Production enablement is approved only after the current `docs/square-service-booking-setup.md` local/staging verification sequence is complete, redacted release evidence is recorded, `/api/admin/payment-reconciliation` returns `ok: true`, and production Square webhook subscriptions include the payment and invoice events used by the shared webhook URL.
- [ ] Production `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true` remains disabled until staging shows no unresolved `manual_followup`, pending charge/capture, refund-required, Calendar-projection, or provider-mismatch findings. When disabled, new payment sessions must fail closed.

## Ecommerce Product Catalog Checks

### Chit Chats region and source-controlled shipping config gate

Shipping/checkout readiness is now **source-controlled policy config plus externally verified account facts, not owner-attested DB records**. The former per-duty assignments, step-up attestations, funding reviews, and versioned calendar/service-policy/tax-policy/manual-policy/provider-certification/intake-location-attestation DB rows were removed. Calendar, service, tax, and manual-policy values live in `src/lib/shipping/product-shipping-config.ts` and `src/lib/commerce/product-tax-policy.ts`; the physical intake location remains an external Chit Chats account/business fact and is not represented by a source constant. Legal/regulatory policy and account facts are verified operationally by the owner. Change-detection between quote and checkout-commit is version-based (`policyVersion` / `taxPolicyVersion`).

- [ ] `CHITCHATS_REGION` matches the Chit Chats account region where shipments first enter its network, and matches the target `CHITCHATS_ENVIRONMENT` and `CHITCHATS_CLIENT_ID`.
- [ ] The actual physical intake location where parcels first enter the Chit Chats network is confirmed by the owner against the live Chit Chats account and matches `CHITCHATS_REGION`. There is no source-controlled intake-location value, DB attestation record, step-up, or `validUntil` to verify.
- [ ] Calendar `branch_closure` entries in `PRODUCT_SHIPPING_BRANCH_CLOSURES` cover announced closures of that physical intake location (statutory Ontario holidays are computed automatically). "branch" is a compatibility label for the physical branch, drop spot, or mail-in hub, not an API identifier.
- [ ] Service-policy `insuranceLimitCents` and `signatureCapable` in `PRODUCT_SHIPPING_SERVICE_POLICIES` are reverified against Chit Chats' current published per-service coverage. The current source uses a CAD 800 cap derived from the published USD 800 fully-tracked maximum confirmed in August 2026. Bump `PRODUCT_SHIPPING_POLICY_VERSION` on any change.
- [ ] Tax coverage is the source-controlled destination-based GST/HST code table (`src/lib/commerce/product-tax-policy.ts`); Ontario 13% HST for studio-pickup and CA destinations, US = $0. Confirm rates before production and bump `PRODUCT_TAX_POLICY_VERSION` on any change.
- [ ] The U.S. DDU contract (`PRODUCT_SHIPPING_US_DDU_CONTRACT`) and manual (studio pickup) cancellation policy (`PRODUCT_MANUAL_CANCELLATION_POLICY`) are populated, and their disclosure/policy **text** and schema **versions** are **confirmed with the business/legal owner** before production. The contract's `effectiveFrom`/`effectiveUntil` window is **not enforced** (managed outside the storefront); the former per-SKU `usRegulatoryCertification.validUntil` interlock has also been removed. The live U.S. eligibility gate is `usShippingApproved` plus a 10-digit `hsTariffCode` (see `src/lib/commerce/product-checkout-eligibility.ts`).
- [ ] Chit Chats postage funding is managed on the Chit Chats account (sufficient balance + auto-reload) by the business owner; there is no local funding gate or reservation ledger.
- [ ] `CHITCHATS_CHECKOUT_ENABLED` remains `false` until this gate and every other applicable shipping, payment, tax, CMS, and staging-acceptance gate passes. `CHITCHATS_US_SHIPPING_ENABLED` (U.S. shipping) and `MANUAL_PRODUCT_CHECKOUT_ENABLED` (studio pickup) additionally require their source config populated (above); both are enabled in **staging (Preview)** and remain disabled in **production** until the business confirms the config.
- [ ] Audit staging OpenTelemetry exports, Vercel request/access logs, support exports, and retained traces for Chit Chats signed label URLs, payment tokens, and customer PII. Purge confirmed exposures under the approved incident process and retain non-secret purge evidence before launch.
- [ ] `npm run test:coverage:critical` passes the committed source-level critical-branch thresholds. `npm run test:browser:verify` proves required browser scenarios ran without skips; it does not replace source coverage.
- [ ] Complete live enabled-mode provider checks for active Canada/U.S. DDU shipping and studio-pickup paths: quote validation, stock reservation/release, Square charge, postage purchase, label retrieval, refund/reconciliation, worker retry, and customer email delivery. Do not carry forward certification items for the fulfillment-policy/risk and post-sale customer-link subsystems removed by migration `0075`.
- [ ] Package-profile approval demonstrates a fresh Google step-up bound to the exact action and target; the proof is single-use and expires.
- [ ] Rollback ownership is recorded separately for `CHITCHATS_CHECKOUT_ENABLED`, `CHITCHATS_US_SHIPPING_ENABLED`, and `MANUAL_PRODUCT_CHECKOUT_ENABLED`; `CHITCHATS_SHIPPING_ENABLED` remains enabled for already-paid work.

- [ ] Product launch scope records the exact enabled flags and supported fulfillment modes. Canada/U.S. DDU shipping and manual studio pickup remain unavailable unless their independent flags and source-controlled policy configuration pass readiness; no hidden fallback mode is assumed.
- [ ] Product catalog cards show the intended availability labels, variant options, SKU-backed pricing, and fulfillment notes from the target Sanity dataset.
- [ ] Unavailable products and unavailable variants cannot be checked out; the checkout route rebuilds catalog identity/pricing from published Sanity data, applies current promotion/tax/shipping policy, and enforces authoritative PostgreSQL stock before payment.
- [ ] Product checkout confirmation email is sent after verified payment persistence and includes order reference, line items, quantities, totals, shipping destination, and fulfillment/support copy.
- [ ] Product confirmation email failures are logged for follow-up and do not roll back a successfully persisted paid order.

## Live Staging Smoke Matrix

These checks require live staging approval, real staging credentials, and recorded evidence. They are separate from mocked Playwright UX tests and must not be treated as completed by local mocks.

| Area                           | Live staging check                                                                                                                                                                                                                                                                                                                         | Required evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Result |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Product checkout               | Complete a product cart checkout through the staging Square card flow (Web Payments SDK).                                                                                                                                                                                                                                                  | Order reference, approved Square test payment, product confirmation page evidence, and Resend product order confirmation message ID/status with addresses redacted.                                                                                                                                                                                                                                                                                                                                                            |        |
| Training checkout              | Complete a paid training checkout through the staging Square card flow (Web Payments SDK). If `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`, also complete a training checkout that creates and publishes a Square invoice and verify `invoice.payment_made` finalizes the enrollment through `/api/webhooks/square`.                    | Order reference, approved Square test payment, order-only confirmation URL, and order-based scheduling link evidence. For the Square invoice path, also include redacted Square invoice/order references, webhook delivery evidence, and idempotency proof.                                                                                                                                                                                                                                                                     |        |
| Service booking checkout       | Complete an operational service booking through the staging Square `CHARGE_AND_STORE` flow. Verify deposit/full/custom partial selection where allowed and verify disabling direct payment fails a new payment session closed.                                                                                                                | Hold/appointment references, redacted Square object types and short prefixes only, captured amount, allowed brand/last-4/expiry metadata, no-show record, policy acceptance, booking confirmation, and Google Calendar event ID. Prohibit raw `sourceId`, verification tokens, full card/customer IDs, and PII in evidence.                                                                                                                                            |        |
| Square shared webhook          | Verify `/api/webhooks/square` accepts signed product, training, service-booking, and optional training-invoice events that are enabled for the release and reconciles each idempotently.                                                                                                                                                      | Vercel log/event ID, accepted signature, idempotency evidence, and redacted provider reference.                                                                                                                                                                                                                                                                                                                                                                                                                                 |        |
| Private DB state               | Confirm checkout/order rows, appointment hold rows, training enrollment rows, payment events, marketing contact submissions, and consent events reach the expected states.                                                                                                                                                                 | Redacted query output showing pending-to-paid transition, hold state transition to booked/manual follow-up, idempotent event storage, form submission evidence, opt-in consent evidence, and no-opt-in audit evidence.                                                                                                                                                                                                                                                                                                          |        |
| Paid training schedule gate    | Confirm paid training scheduling uses `/training-programs/[slug]/schedule?token=...`, rejects invalid/unpaid/expired/wrong-program tokens, and exposes the Google Appointment Schedule URL only after private token eligibility passes.                                                                                                    | Tokenized schedule URL behavior, negative-case rejection evidence, and Appointment Schedule render evidence with PII redacted.                                                                                                                                                                                                                                                                                                                                                                                                  |        |
| Service booking Calendar event | Complete a paid service booking against the staging calendar.                                                                                                                                                                                                                                                                              | Google Calendar event ID/timestamp and booking metadata with PII redacted.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |        |
| Sanity revalidation            | Publish a staging Sanity edit and verify signed webhook-driven page refresh.                                                                                                                                                                                                                                                               | Publish timestamp, webhook delivery result, cache tag/log reference, and before/after page evidence.                                                                                                                                                                                                                                                                                                                                                                                                                            |        |
| Calendar OAuth and storage     | Connect through `/admin/calendar-connections`; verify encrypted PostgreSQL credential storage and one-time Redis OAuth state consumption.                                                                                                                                                                                                  | Redacted connection/assignment IDs, callback result, state replay rejection, and post-restart calendar discovery evidence.                                                                                                                                                                                                                                                                                                                                                                                                      |        |
| Scheduled jobs                | Verify every enabled `vercel.json` cron receives an authorized request and reaches its expected healthy or explicitly-disabled response.                                                                                                                                                                                                   | Redacted Vercel cron delivery/log evidence for retention, backup validation, payment reconciliation, Chit Chats worker, email outbox, abandoned stock sweep, marketing sync, and shipping-rate refresh as applicable.                                                                                                                                                                                                                                                                                                            |        |
| Resend emails                  | Trigger general inquiry, training contact, contact popup, customer booking confirmation, provider booking confirmation, training payment, and product order confirmation emails after private DB writes. Verify the provider email shows the service, confirmed time/timezone, payment type, captured booking amount, tip, and total paid. | Resend message IDs/statuses and verified-domain evidence with addresses redacted.                                                                                                                                                                                                                                                                                                                                                                                                                                               |        |

## Privacy and Compliance Gates

These gates are technical planning support, not legal advice. Final retention, consent wording, lawful-basis, DSAR, and ownership decisions require business and qualified privacy/legal review.

- [ ] Consent evidence is captured for submitted email, normalized email, source form/path, consent timestamp, exact displayed consent/CTA text, privacy link snapshot when available, and source system/doc ID for backfill.
- [ ] No-opt-in booking choices are audited without adding or updating consolidated marketing-contact rows.
- [ ] No new `generalInquiry`, `contactForm`, `contactPopupSubmission`, or `bookingMarketingOptIn` Sanity documents are created by live flows.
- [ ] Retention/redaction owner and counsel decision checkpoint are recorded by record type.
- [ ] DSAR/access/correction/deletion owner and workflow checkpoint are recorded.
- [ ] Unsubscribe/suppression decision is recorded before any bulk marketing send workflow, including withdrawal events, future-send suppression, and CASL 10-business-day handling as a planning checkpoint.
- [ ] Lawful-basis/purpose tracking decisions are pending or recorded separately for marketing emails, transactional emails, inquiry response, training follow-up, booking operational communication, suppression retention, and compliance audit evidence.
- [ ] PII-safe logging is verified: no raw form payloads, customer PII, full connection strings, payment tokens, or raw webhook bodies in logs or launch evidence.
- [ ] Current private-record Admin pages (`/admin/appointments`, `/admin/orders`, `/admin/inquiries`, `/admin/marketing`, `/admin/payments`, and related detail pages) require authenticated RBAC, enforce resource scope where applicable, and write auditable administrative actions. Anonymous and unauthorized access is denied.
- [ ] Nataliea is recorded as accountable business/privacy owner for consent, retention, unsubscribe, DSAR, and record disposition decisions.
- [ ] Dardan's role is recorded as contract technical operator/steward during active engagement, with no permanent DSAR, retention, unsubscribe, or compliance ownership unless separately contracted.
- [ ] Post-contract owner or vendor is named for DSARs, unsubscribe checks, access reviews, retention jobs, and incident response.
- [ ] Contractor access scope, least-privilege permissions, approved PII access, and contract-end access revocation/rotation steps are documented.

## Scheduled Job Readiness

Verify the deployed schedules match `vercel.json`; do not infer cadence from a runbook. Use `docs/scheduled-jobs-runbook.md` for response fields, failure counters, and disabled-mode semantics. Vercel scheduled requests use `CRON_SECRET` as the bearer. Route-specific secrets enable additional manual/operational access but do not replace the enablement rules in code.

| Route | Schedule | Required authorization/configuration |
| ----- | -------- | ------------------------------------ |
| `/api/admin/private-data-retention` | `17 8 * * *` | `CRON_SECRET` |
| `/api/cron/backup-validation` | `0 6 * * 1` | `CRON_SECRET`; configuration scaffold only, with `manualActionRequired: true`; external restore runner required |
| `/api/admin/payment-reconciliation` | `*/30 * * * *` | `PAYMENT_RECONCILIATION_CRON_SECRET` must exist; then either it or `CRON_SECRET` is accepted |
| `/api/cron/chitchats-shipping` | `* * * * *` | `CHITCHATS_WORKER_CRON_SECRET` or `CRON_SECRET`; shipping work depends on feature readiness |
| `/api/cron/customer-email-outbox` | `*/5 * * * *` | `CRON_SECRET` |
| `/api/cron/product-stock-reservations` | `*/15 * * * *` | `CRON_SECRET` |
| `/api/admin/marketing-contact-sync` | `*/5 * * * *` | `RESEND_MARKETING_SYNC_CRON_SECRET` must exist; then either it or `CRON_SECRET` is accepted |
| `/api/cron/shipping-rate-cache-refresh` | `30 7 * * 1` | `CHITCHATS_WORKER_CRON_SECRET` or `CRON_SECRET`; work runs only when flat-rate shipping is enabled |

- [ ] Each enabled route returns its expected result when called by Vercel Cron and rejects a missing or incorrect bearer. Inspect response counters and logs; HTTP `200` alone is not sufficient for payment reconciliation, stock sweeping, marketing sync, or backup validation.
- [ ] Payment reconciliation has no unresolved captured-without-appointment, appointment-without-capture, Calendar-pending, refund-required, or provider-mismatch findings.
- [ ] Customer email, marketing sync, and stock-reservation queues have no stale claimed jobs or unexpected dead letters.
- [ ] Cron logs and alerts contain no bearer tokens, connection strings, payment tokens, raw webhook bodies, or customer PII.

## Launch Day Monitoring and Escalation

During the launch window, the following logs and behaviors must be monitored.

### Webhook Watchlist (Vercel Logs)

Monitor `/api/revalidate` and, when configured separately, `/api/webhooks/sanity/inventory-sync` for these critical signals:

- [ ] **401 Unauthorized:** Indicates `SANITY_WEBHOOK_SECRET` is missing or mismatched. **Action:** Verify environment variables in Vercel and Sanity.
- [ ] **400 Bad Request:** Indicates missing `_type`; the inventory endpoint also requires the product `_id`. **Action:** Verify the Sanity webhook projection is `{ _id, _type }`.
- [ ] **5xx Errors:** Indicates route handler failure. **Action:** Check logs for "parseBody" or "revalidateTag" errors.
- [ ] **Repeated Failures:** If Sanity retries the same webhook multiple times, it indicates a persistent timeout or crash.
- [ ] **Stale Content:** If a 200 OK is logged but the public page does not update. **Action:** Verify tag alignment between `src/app/api/revalidate/handler.ts` and `src/data/loaders.ts`.
- [ ] **Stock Drift:** If a product publish revalidates but PostgreSQL stock does not reflect a changed Sanity set-point. **Action:** Confirm the delivery included `_id`, then inspect the revalidation after-response stock-sync log or the dedicated inventory webhook delivery.

### Escalation and Ownership

If any stop conditions are met or critical failures are observed:

- **Accountable Business/Privacy Owner:** Nataliea
- **Contract Technical Operator/Steward:** Dardan, while actively engaged on the project
- **Post-Contract Operator:** Nataliea or named vendor, to be recorded before launch

**Escalation Path:**

1. **Immediate:** Notify Dardan of any 401/400/5xx errors or stale content after a production publish.
2. **Triage:** Dardan to verify Vercel logs and Sanity webhook delivery status.
3. **Remediation:** If the webhook cannot be fixed within 15 minutes, Nataliea pauses production content updates until signed revalidation is restored. Do not rely on a universal 30-minute fallback; route caching varies and operational booking pages are dynamic.

## Stop Conditions

- **Stale Content:** If a production publish does not appear on the public page after signed webhook delivery, stop.
- **Wrong Targeting:** If the webhook targets the wrong dataset or cache tag, stop.
- **Inventory Sync Failure:** If a product stock set-point publish cannot be reconciled to PostgreSQL, stop product checkout changes until stock is verified.
- **Environment Mismatch:** If Studio edits affect the wrong environment, stop.
- **PII Leak:** If any customer PII or payment data is found in Sanity, stop and remediate.
- **Live Submission Leak:** If a live form or booking marketing flow creates new Sanity submission documents, stop and remediate.
- **Database Identity Mismatch:** If `DATABASE_URL` cannot be independently verified as the correct target, stop.
- **Backup Failure:** If production backups or PITR are unavailable or unverified, stop.
- **Migration Failure:** If a migration command fails or the database becomes unreachable, stop and follow `docs/private-database-migration-runbook.md` failure handling; do not restore automatically.
- **Missing Approval:** If the migration approver has not signed off on the production run, stop.
- **Missing Operating Owner:** If no post-contract owner or vendor is named for private-record operations, stop.
