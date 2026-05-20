# Launch Readiness Checklist

This checklist must be completed and recorded for both Staging and Production environments before declaring a release "Ready".

## Environment Validation

- [ ] `NEXT_PUBLIC_SANITY_PROJECT_ID` matches `3auncj84`.
- [ ] `NEXT_PUBLIC_SANITY_DATASET` matches target (`staging-2026-05-10` or `production`).
- [ ] `SANITY_WEBHOOK_SECRET` is configured and matches the Sanity webhook panel.
- [ ] `DATABASE_URL` is reachable and migrations are up to date.
- [ ] `KV_REST_API_URL` and tokens are valid.
- [ ] Helcim API tokens and webhook verifier are configured.
- [ ] Resend API key and `FROM_EMAIL` are configured.
- [ ] `VERCEL_ENV=preview node scripts/validate-sanity-env.mjs` passes for staging variables.
- [ ] `VERCEL_ENV=production node scripts/validate-sanity-env.mjs` passes for production variables.

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

## CMS Smoke Matrix

For each document type, verify the publish flow: Update content in Studio -> Publish -> Verify Webhook -> Verify Public Page.

| Environment | Dataset | Document Type | Test Edit | Webhook Status | Cache Tag | Public URL | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | `homePage` | | | `homePage` | `/` | |
| | | `contactPage` | | | `contactPage` | `/contact` | |
| | | `galleryPage` | | | `galleryPage` | `/gallery` | |
| | | `globalSettings` | | | `global` | (All pages) | |
| | | `mainMenu` | | | `menu` | (All pages) | |
| | | `trainingPage` | | | `trainingPage` | `/training` | |
| | | `trainingProgramsPage` | | | `trainingProgramsPage`, `trainingProgram` | `/training-programs` | |
| | | `trainingProgram` | | | `trainingProgram` | `/training-programs/[slug]` | |
| | | `product` | | | `product` | `/products`, `/products/[slug]` | |
| | | `service` | | | `service` | `/services`, `/services/[slug]`, `/booking?offering=<slug>` | |
| | | `bookingOffering` | | | `bookingOffering` | `/booking?offering=<slug>` | |
| | | `bookingSettings` | | | `bookingSettings` | `/booking` | |

## Service Integration Checks

- [ ] **Booking:** Visit `/booking`, confirm slots load from Google Calendar.
- [ ] **Paid appointment booking:** Visit an explicit service/offering booking URL, create a hold, complete deposit/full/custom partial Helcim checkout in staging, and confirm Google Calendar insertion happens only after verified payment.
- [ ] **Checkout:** Add product to cart, proceed to Helcim checkout page (test mode).
- [ ] **Forms:** Submit general inquiry, training contact, and contact popup tests; confirm private DB submission/consent evidence and Resend email delivery with PII redacted in evidence.
- [ ] **Booking Marketing Choices:** Create one booking with marketing opt-in and one without; confirm both choices create private DB audit evidence, only affirmative consent updates the consolidated marketing contact, and no new Sanity submission documents are created.

## Ecommerce Product Catalog Checks

- [ ] Product launch scope is recorded as excluding taxes for general products, discounts, shipping, ACH, partial payments, refunds tooling, saved payment methods, and customer pre-linking.
- [ ] Product catalog cards show the intended availability labels, variant options, SKU-backed pricing, and fulfillment notes from the target Sanity dataset.
- [ ] Unavailable products and unavailable variants cannot be checked out; the checkout route rebuilds line items, prices, currency, and totals from server-fetched Sanity product data only.
- [ ] Product checkout confirmation email is sent after verified payment persistence and includes order reference, line items, quantities, totals, and fulfillment/support copy.
- [ ] Product confirmation email failures are logged for follow-up and do not roll back a successfully persisted paid order.

## Live Staging Smoke Matrix

These checks require live staging approval, real staging credentials, and recorded evidence. They are separate from mocked Playwright UX tests and must not be treated as completed by local mocks.

| Area | Live staging check | Required evidence | Result |
| --- | --- | --- | --- |
| Product checkout | Complete a product cart checkout through the staging Helcim flow. | Checkout/invoice reference, approved test transaction, product confirmation page evidence, and Resend product order confirmation message ID/status with addresses redacted. | |
| Training checkout | Complete a paid training checkout through the staging Helcim flow. | Checkout/invoice reference, approved test transaction, order-only confirmation URL, and order-based scheduling link evidence. | |
| Appointment checkout | Complete deposit, full, and custom partial appointment payments through the staging Helcim flow. | Hold reference, checkout/order reference, approved test transaction, booking confirmation evidence, and Google Calendar event ID created after payment validation. | |
| Helcim webhook | Verify `/api/webhooks/card-transactions` receives and accepts the card transaction event. | Vercel log/event ID, accepted signature, idempotency key, and redacted transaction reference. | |
| Private DB state | Confirm checkout/order rows, appointment hold rows, training enrollment rows, payment events, marketing contact submissions, and consent events reach the expected states. | Redacted query output showing pending-to-paid transition, hold state transition to booked/manual follow-up, idempotent event storage, form submission evidence, opt-in consent evidence, and no-opt-in audit evidence. | |
| Paid training booking gate | Confirm paid training booking rejects legacy token links and requires the checkout email for the order-based scheduling link. | Legacy token rejection evidence, order-based booking link behavior, checkout-email mismatch rejection evidence, and Calendar event evidence. | |
| Booking Calendar event | Create a standard booking and a paid training booking against the staging calendar. | Google Calendar event IDs/timestamps and booking metadata with PII redacted. | |
| Sanity revalidation | Publish a staging Sanity edit and verify signed webhook-driven page refresh. | Publish timestamp, webhook delivery result, cache tag/log reference, and before/after page evidence. | |
| Redis/Upstash | Verify OAuth refresh token access, booking locks, idempotency, and TTL behavior. | Redacted Upstash key/TTL evidence or runtime logs proving read/write/expiry. | |
| Resend emails | Trigger general inquiry, training contact, contact popup, booking confirmation, training payment, and product order confirmation emails after private DB writes. | Resend message IDs/statuses and verified-domain evidence with addresses redacted. | |

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
