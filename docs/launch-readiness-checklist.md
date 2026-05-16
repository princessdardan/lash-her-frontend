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
| | | `trainingProgramsPage` | | | `trainingProgramsPage` | `/training-programs` | |
| | | `trainingProgram` | | | `trainingProgram` | `/training-programs/[slug]` | |
| | | `sellableProduct` | | | `sellableProduct` | `/products/[slug]` | |
| | | `bookingSettings` | | | `bookingSettings` | `/booking` | |

## Service Integration Checks

- [ ] **Booking:** Visit `/booking`, confirm slots load from Google Calendar.
- [ ] **Checkout:** Add product to cart, proceed to Helcim checkout page (test mode).
- [ ] **Forms:** Submit a test inquiry, confirm Sanity record creation and Resend email delivery.

## Live Staging Smoke Matrix

These checks require live staging approval, real staging credentials, and recorded evidence. They are separate from mocked Playwright UX tests and must not be treated as completed by local mocks.

| Area | Live staging check | Required evidence | Result |
| --- | --- | --- | --- |
| Product checkout | Complete a product cart checkout through the staging Helcim flow. | Checkout/invoice reference, approved test transaction, and confirmation evidence. | |
| Training checkout | Complete a paid training checkout through the staging Helcim flow. | Checkout/invoice reference, approved test transaction, and scheduling link evidence. | |
| Helcim webhook | Verify `/api/webhooks/card-transactions` receives and accepts the card transaction event. | Vercel log/event ID, accepted signature, idempotency key, and redacted transaction reference. | |
| Private DB state | Confirm checkout/order rows, training enrollment rows, and payment events reach the expected states. | Redacted query output showing pending-to-paid transition and idempotent event storage. | |
| Scheduling token | Confirm paid training checkout issues a valid booking token. | Redacted token record/log, valid booking link behavior, and mismatched/expired token rejection evidence. | |
| Booking Calendar event | Create a standard booking and a paid training booking against the staging calendar. | Google Calendar event IDs/timestamps and booking metadata with PII redacted. | |
| Sanity revalidation | Publish a staging Sanity edit and verify signed webhook-driven page refresh. | Publish timestamp, webhook delivery result, cache tag/log reference, and before/after page evidence. | |
| Redis/Upstash | Verify OAuth refresh token access, booking locks, idempotency, and TTL behavior. | Redacted Upstash key/TTL evidence or runtime logs proving read/write/expiry. | |
| Resend emails | Trigger general inquiry, training contact, booking confirmation, and training payment emails. | Resend message IDs/statuses and verified-domain evidence with addresses redacted. | |

## Stop Conditions

- **Stale Content:** If a production publish does not appear on the public page after signed webhook delivery, stop.
- **Wrong Targeting:** If the webhook targets the wrong dataset or cache tag, stop.
- **Environment Mismatch:** If Studio edits affect the wrong environment, stop.
- **PII Leak:** If any customer PII or payment data is found in Sanity, stop and remediate.
