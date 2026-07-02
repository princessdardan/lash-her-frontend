# Launch Readiness Checklist

This checklist must be completed and recorded for both Staging and Production environments before declaring a release "Ready".

## Environment Validation

- [ ] `NEXT_PUBLIC_SANITY_PROJECT_ID` matches `3auncj84`.
- [ ] `NEXT_PUBLIC_SANITY_DATASET` matches target (`staging-2026-05-10` or `production`).
- [ ] `SANITY_WEBHOOK_SECRET` is configured and matches the Sanity webhook panel.
- [ ] `DATABASE_URL` is reachable and migrations are up to date.
- [ ] `KV_REST_API_URL` and tokens are valid.
- [ ] `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` match the environment OAuth client.
- [ ] `BOOKING_ADMIN_SETUP_SECRET` is configured for the protected Google Calendar OAuth setup flow and stored server-only.
- [ ] `CHECKOUT_SECRET_ENCRYPTION_KEY` is configured as a base64-encoded 32-byte server-only secret.
- [ ] Helcim API tokens and webhook verifier are configured.
- [ ] `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true` is set only when the optional training Afterpay Square Invoice flow is intended; otherwise it is unset or `false`.
- [ ] If `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true` for production, Square merchant eligibility for live CAD invoices is verified and recorded.
- [ ] `SERVICE_BOOKING_SQUARE_ENABLED=true` is set only when Square-backed service booking is intended; otherwise it is unset or `false`. Card-on-file service booking additionally requires `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true`.
- [ ] If `SERVICE_BOOKING_SQUARE_ENABLED=true`, the code-required Square environment values are configured: `SQUARE_ENVIRONMENT`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_SERVICE_BOOKING_RETURN_URL`, and `SQUARE_SERVICE_BOOKING_WEBHOOK_URL`. The shared `SQUARE_SERVICE_BOOKING_WEBHOOK_URL` is the endpoint Square delivers to for service booking, no-show, and training invoice events.
- [ ] If `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true`, the public-safe `SQUARE_APPLICATION_ID` is also configured for the Square Web Payments SDK config route. `SQUARE_APPLICATION_ID` is not a secret and must not be treated as one.
- [ ] `PAYMENT_RECONCILIATION_CRON_SECRET` is configured and is required to enable the payment reconciliation route; it is distinct from the generic `CRON_SECRET` used by Vercel scheduled cron. The route accepts either bearer when both secrets are configured, but the route-specific secret must be present for the route to be enabled or for manual/staff checks.
- [ ] If `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`, the code-required Square environment values are configured: `SQUARE_ENVIRONMENT`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, and `SQUARE_SERVICE_BOOKING_WEBHOOK_URL`. The shared `SQUARE_SERVICE_BOOKING_WEBHOOK_URL` is the endpoint Square delivers to for service booking, no-show, and training invoice events. Training Square Invoice alone does not require `SQUARE_SERVICE_BOOKING_RETURN_URL` or `SQUARE_APPLICATION_ID`.
- [ ] `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_SEGMENT_MARKETING_ID`, `FROM_EMAIL`, and `ADMIN_EMAIL` are configured.
- [ ] `VERCEL_ENV=preview node scripts/validate-sanity-env.mjs` passes for staging variables.
- [ ] `VERCEL_ENV=production node scripts/validate-sanity-env.mjs` passes for production variables.
- [ ] `npm run check:square-card-on-file-env` passes when Square service booking/card-on-file is enabled.

## Private Database Migration Readiness

Use `docs/private-database-migration-runbook.md` for the complete migration procedure and evidence template.

- [ ] Staging database identity is manually verified and recorded.
- [ ] Production database identity is manually verified and recorded.
- [ ] Backup and PITR capability is verified for the production target.
- [ ] Migration approver is assigned and aware of the migration window.
- [ ] Migration evidence template is ready for recording the run.
- [ ] Staging smoke tests pass with the latest database schema.
- [ ] Retention and redaction owner is identified.
- [ ] Shared private PII tables are present for checkout orders, payment events, appointment holds, training enrollments, marketing contacts, contact submissions, and consent events.
- [ ] Backfill dry-run/execute evidence template, provenance fields, duplicate protection, and stop conditions are ready before any backfill command is approved.
- [ ] Sanity submission source retention/redaction owner decision is identified before historical submission records are imported, hidden, redacted, or deleted.
- [ ] Card-on-file DB integrity verified: latest private DB migrations applied, hold-side no-show/policy foreign keys present, and `npx tsx --test src/lib/private-db/card-on-file-repository.db.test.ts src/lib/booking/payments/service-reconciliation-monitor.test.ts` passes against staging. Load `TEST_DATABASE_URL` from a protected env file or session (do not paste the connection string into shell history or an inline placeholder).

## CMS Smoke Matrix

For each document type, verify the publish flow: Update content in Studio -> Publish -> Verify Webhook -> Verify Public Page.

| Environment | Dataset | Document Type          | Test Edit | Webhook Status | Cache Tag                                 | Public URL                                                  | Result |
| ----------- | ------- | ---------------------- | --------- | -------------- | ----------------------------------------- | ----------------------------------------------------------- | ------ |
|             |         | `homePage`             |           |                | `homePage`                                | `/`                                                         |        |
|             |         | `contactPage`          |           |                | `contactPage`                             | `/contact`                                                  |        |
|             |         | `galleryPage`          |           |                | `galleryPage`                             | `/gallery`                                                  |        |
|             |         | `globalSettings`       |           |                | `global`                                  | (All pages)                                                 |        |
|             |         | `mainMenu`             |           |                | `menu`                                    | (All pages)                                                 |        |
|             |         | `trainingProgramsPage` |           |                | `trainingProgramsPage`, `trainingProgram` | `/training-programs` (`/training` redirects here)           |        |
|             |         | `trainingProgram`      |           |                | `trainingProgram`                         | `/training-programs/[slug]`                                 |        |
|             |         | `product`              |           |                | `product`                                 | `/products`, `/products/[slug]`                             |        |
|             |         | `service`              |           |                | `service`                                 | `/services`, `/services/[slug]`, `/booking?offering=<slug>` |        |
|             |         | `bookingSettings`      |           |                | `bookingSettings`                         | `/booking`                                                  |        |

## Service Integration Checks

- [ ] **Booking:** Visit `/booking`, confirm slots load from Google Calendar.
- [ ] **Paid service booking:** Visit an explicit service/offering booking URL, create a hold, and complete confirmation through the active flow:
  - Primary (card-on-file enabled): accept the no-show/cancellation policy, save a Square sandbox card, and confirm Google Calendar insertion only after the saved card, policy acceptance, and no-show record are persisted.
  - Legacy fallback/window coverage (card-on-file disabled or unavailable): complete deposit/full/custom partial Square hosted checkout in staging and confirm Google Calendar insertion happens only after verified payment.
  - In both flows, confirm direct `/api/booking/create` requests reject with the secure-payment-required error.
- [ ] **Checkout:** Add product to cart, proceed to Helcim checkout page (test mode).
- [ ] **Training checkout:** Complete a paid training checkout through the Helcim flow. If `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`, also verify the Square invoice path creates and publishes a Square invoice, that `invoice.payment_made` routes to the training Square Invoice finalizer before service-booking/no-show fallback, and that the enrollment is finalized idempotently.
- [ ] **Forms:** Submit general inquiry, training contact, and contact popup tests; confirm private DB submission/consent evidence and Resend email delivery with PII redacted in evidence.
- [ ] **Booking Marketing Choices:** Create one booking with marketing opt-in and one without; confirm both choices create private DB audit evidence, only affirmative consent updates the consolidated marketing contact, and no new Sanity submission documents are created.

## Service Booking Card-on-File Smoke Tests

Run these when `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true` in the target environment. They may be performed in Square sandbox or with safe test credentials. Follow the exact ordering and preflight steps in `docs/square-service-booking-setup.md` under **Card-on-file staging certification order**, run `npm run check:square-card-on-file-env` first, and record evidence in `docs/superpowers/reports/square-card-on-file-sandbox-certification.md`.

- [ ] **Policy blocks confirmation:** Confirm the card-on-file form cannot be submitted while the no-show/cancellation policy checkbox is unchecked.
- [ ] **Sandbox card save succeeds:** Tokenize and save a Square sandbox card; confirm the Cards API returns a card ID and the app stores brand/last-4/expiry metadata only.
- [ ] **Failed card save does not confirm booking:** Simulate a card-save failure and confirm the hold is not marked `booked`, no Google Calendar event is created, and the customer sees a recoverable error.
- [ ] **Booked hold has required records:** Confirm a successfully booked hold has a saved Square card reference, a policy acceptance record, a no-show charge record, and exactly one Google Calendar event.
- [ ] **Admin no-show charge succeeds:** Call `POST /api/admin/appointments/[id]/no-show` with a valid `BOOKING_ADMIN_PAYMENT_ACTION_SECRET` bearer token and a request body of `{ amountCents: <appointment-max-charge-cents>, confirmPolicyCharge: true, idempotencyKey: "<unique-key>", operatorId: "<operator-alias>", reason: "<concise-reason>" }`. Confirm the amount equals the appointment max charge and the no-show charge succeeds against the saved card.
- [ ] **Declined no-show charge records failure:** Simulate a declined no-show charge and confirm the local no-show charge record enters `charge_failed` state and emits an operational alert.
- [ ] **Legacy Payment Link reconciliation:** Confirm any pre-existing or fallback legacy Square Payment Link payments still reconcile through `/api/booking/square/return` and `/api/webhooks/square`, or are safely routed to manual review if they cannot be matched.

## Square card-on-file production enablement gate

- [ ] Square card-on-file production enablement approved: the sandbox certification report in `docs/superpowers/reports/square-card-on-file-sandbox-certification.md` is complete, the staging smoke run in `docs/square-service-booking-setup.md` **Card-on-file staging certification order** is complete, reconciliation route returns `ok: true`, and production Square webhook subscriptions include invoice and payment events for the shared webhook URL.
- [ ] Production `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true` remains disabled until the certification report is approved and the staging smoke run shows no unresolved `manual_followup`, `charge_pending`, or provider mismatch states.

## Ecommerce Product Catalog Checks

- [ ] Product launch scope is recorded as collecting a shipping address for fulfillment while excluding taxes for general products, discounts, shipping-rate calculation, ACH, partial payments, refunds tooling, saved payment methods, and customer pre-linking.
- [ ] Product catalog cards show the intended availability labels, variant options, SKU-backed pricing, and fulfillment notes from the target Sanity dataset.
- [ ] Unavailable products and unavailable variants cannot be checked out; the checkout route rebuilds line items, prices, currency, and totals from server-fetched Sanity product data only.
- [ ] Product checkout confirmation email is sent after verified payment persistence and includes order reference, line items, quantities, totals, shipping destination, and fulfillment/support copy.
- [ ] Product confirmation email failures are logged for follow-up and do not roll back a successfully persisted paid order.

## Live Staging Smoke Matrix

These checks require live staging approval, real staging credentials, and recorded evidence. They are separate from mocked Playwright UX tests and must not be treated as completed by local mocks.

| Area                           | Live staging check                                                                                                                                                                                                                                                                              | Required evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Result |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Product checkout               | Complete a product cart checkout through the staging Helcim flow.                                                                                                                                                                                                                               | Checkout/invoice reference, approved test transaction, product confirmation page evidence, and Resend product order confirmation message ID/status with addresses redacted.                                                                                                                                                                                                                                                                                                                                                     |        |
| Training checkout              | Complete a paid training checkout through the staging Helcim flow. If `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED=true`, also complete a training checkout that creates and publishes a Square invoice and verify `invoice.payment_made` finalizes the enrollment through `/api/webhooks/square`. | Checkout/invoice reference, approved test transaction, order-only confirmation URL, and order-based scheduling link evidence. For the Square invoice path, also include redacted Square invoice/order references, webhook delivery evidence, and idempotency proof.                                                                                                                                                                                                                                                             |        |
| Service booking checkout       | Complete paid service booking confirmation through the staging Square card-on-file flow; verify Square hosted Payment Link deposit/full/custom partial payments only for legacy fallback or window coverage.                                                                                    | Hold reference, redacted Square object refs only (type + short/redacted prefix such as `card: ccof/...`, `customer: ...`, `invoice: inv/...`), confirmation that only allowed brand/last-4/expiry metadata was stored, no-show record, policy acceptance, approved test transaction if a legacy Payment Link is exercised, booking confirmation evidence, and Google Calendar event ID created after card save or payment validation. Prohibit raw `sourceId`, verification token, full card/customer IDs, and PII in evidence. |        |
| Helcim webhook                 | Verify `/api/webhooks/card-transactions` receives and accepts the card transaction event.                                                                                                                                                                                                       | Vercel log/event ID, accepted signature, idempotency key, and redacted transaction reference.                                                                                                                                                                                                                                                                                                                                                                                                                                   |        |
| Private DB state               | Confirm checkout/order rows, appointment hold rows, training enrollment rows, payment events, marketing contact submissions, and consent events reach the expected states.                                                                                                                      | Redacted query output showing pending-to-paid transition, hold state transition to booked/manual follow-up, idempotent event storage, form submission evidence, opt-in consent evidence, and no-opt-in audit evidence.                                                                                                                                                                                                                                                                                                          |        |
| Paid training schedule gate    | Confirm paid training scheduling uses `/training-programs/[slug]/schedule?token=...`, rejects invalid/unpaid/expired/wrong-program tokens, and exposes the Google Appointment Schedule URL only after private token eligibility passes.                                                         | Tokenized schedule URL behavior, negative-case rejection evidence, and Appointment Schedule render evidence with PII redacted.                                                                                                                                                                                                                                                                                                                                                                                                  |        |
| Service booking Calendar event | Complete a paid service booking against the staging calendar.                                                                                                                                                                                                                                   | Google Calendar event ID/timestamp and booking metadata with PII redacted.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |        |
| Sanity revalidation            | Publish a staging Sanity edit and verify signed webhook-driven page refresh.                                                                                                                                                                                                                    | Publish timestamp, webhook delivery result, cache tag/log reference, and before/after page evidence.                                                                                                                                                                                                                                                                                                                                                                                                                            |        |
| Redis/Upstash                  | Verify OAuth refresh token access, booking locks, idempotency, and TTL behavior.                                                                                                                                                                                                                | Redacted Upstash key/TTL evidence or runtime logs proving read/write/expiry.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |        |
| Resend emails                  | Trigger general inquiry, training contact, contact popup, booking confirmation, training payment, and product order confirmation emails after private DB writes.                                                                                                                                | Resend message IDs/statuses and verified-domain evidence with addresses redacted.                                                                                                                                                                                                                                                                                                                                                                                                                                               |        |

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
- [ ] No dashboard/admin UI is added for private records until access control, audit logging, and retention policy are approved.
- [ ] Nataliea is recorded as accountable business/privacy owner for consent, retention, unsubscribe, DSAR, and record disposition decisions.
- [ ] Dardan's role is recorded as contract technical operator/steward during active engagement, with no permanent DSAR, retention, unsubscribe, or compliance ownership unless separately contracted.
- [ ] Post-contract owner or vendor is named for DSARs, unsubscribe checks, access reviews, retention jobs, and incident response.
- [ ] Contractor access scope, least-privilege permissions, approved PII access, and contract-end access revocation/rotation steps are documented.

## Launch Day Monitoring and Escalation

During the launch window, the following logs and behaviors must be monitored.

### Webhook Watchlist (Vercel Logs)

Monitor `/api/revalidate` for these critical signals:

- [ ] **401 Unauthorized:** Indicates `SANITY_WEBHOOK_SECRET` is missing or mismatched. **Action:** Verify environment variables in Vercel and Sanity.
- [ ] **400 Bad Request:** Indicates missing `_type` in webhook payload. **Action:** Verify Sanity webhook projection is `{ _type }`.
- [ ] **5xx Errors:** Indicates route handler failure. **Action:** Check logs for "parseBody" or "revalidateTag" errors.
- [ ] **Repeated Failures:** If Sanity retries the same webhook multiple times, it indicates a persistent timeout or crash.
- [ ] **Stale Content:** If a 200 OK is logged but the public page does not update. **Action:** Verify tag alignment between `route.ts` and `loaders.ts`.

### Escalation and Ownership

If any stop conditions are met or critical failures are observed:

- **Accountable Business/Privacy Owner:** Nataliea
- **Contract Technical Operator/Steward:** Dardan, while actively engaged on the project
- **Post-Contract Operator:** Nataliea or named vendor, to be recorded before launch

**Escalation Path:**

1. **Immediate:** Notify Dardan of any 401/400/5xx errors or stale content after a production publish.
2. **Triage:** Dardan to verify Vercel logs and Sanity webhook delivery status.
3. **Remediation:** If the webhook cannot be fixed within 15 minutes, Nataliea to pause production content updates and rely on the 30-minute ISR background refresh until resolved.

## Stop Conditions

- **Stale Content:** If a production publish does not appear on the public page after signed webhook delivery, stop.
- **Wrong Targeting:** If the webhook targets the wrong dataset or cache tag, stop.
- **Environment Mismatch:** If Studio edits affect the wrong environment, stop.
- **PII Leak:** If any customer PII or payment data is found in Sanity, stop and remediate.
- **Live Submission Leak:** If a live form or booking marketing flow creates new Sanity submission documents, stop and remediate.
- **Database Identity Mismatch:** If `DATABASE_URL` cannot be independently verified as the correct target, stop.
- **Backup Failure:** If production backups or PITR are unavailable or unverified, stop.
- **Migration Failure:** If a migration command fails or the database becomes unreachable, stop and follow `docs/private-database-migration-runbook.md` failure handling; do not restore automatically.
- **Missing Approval:** If the migration approver has not signed off on the production run, stop.
- **Missing Operating Owner:** If no post-contract owner or vendor is named for private-record operations, stop.
