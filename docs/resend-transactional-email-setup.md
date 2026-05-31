# Resend Transactional Email Setup

This runbook covers manual Resend and Vercel setup for Lash Her transactional email. The application sends customer/admin operational email through Resend after private database writes for forms, product checkout, paid training, and paid service booking.

Do not store customer PII, payment history, payment tokens, or live form submissions in Resend evidence, Sanity, tickets, docs, PRs, or chat. Redact recipient addresses when recording Resend message IDs or delivery status.

## What The App Sends

Current transactional flows are:

- General inquiry, training contact, and contact popup notifications from `src/lib/email.ts`.
- Product order confirmations from `src/lib/commerce/product-order-email.ts`.
- Training payment customer/admin notifications from `src/lib/commerce/training-payment-email.ts` and `src/lib/commerce/training-payment-notifications.ts`.
- Service booking confirmations from `src/lib/booking/email.ts`.

Payment-related email delivery is intentionally idempotent:

- Product confirmation uses `product-confirmation:<orderId>`.
- Training customer email uses `training-customer:<orderId>`.
- Training admin email uses `training-admin:<orderId>`.
- Booking confirmation uses `booking-confirmation:<holdId>`.

The private database stores email sent/claim/error state so browser validation and webhook retries can recover missed sends without duplicating successfully recorded emails.

## Resend Environment Variables

All Resend variables are server-only. Never add a `NEXT_PUBLIC_` prefix.

```env
RESEND_API_KEY=<resend-api-key>
FROM_EMAIL=<verified-transactional-sender-address>
ADMIN_EMAIL=<admin-recipient-address>
EMAIL_PROFILE_IMAGE_URL=<optional-public-https-profile-image-url>
EMAIL_RETRY_SECRET=<long-random-manual-retry-secret>
```

`EMAIL_PROFILE_IMAGE_URL` is optional. When set, the app renders that public HTTPS image as a small circular profile mark inside the HTML header of transactional emails. It is not a secret and must be reachable by email clients without authentication.

Vercel setup:

1. Add the required variables in the Vercel project settings for the intended environment, and add `EMAIL_PROFILE_IMAGE_URL` only when the transactional header image should be enabled.
2. Scope staging/preview values to Preview and local Development; scope production values to Production only.
3. Use separate Resend API keys for staging and production if the Resend account policy allows it.
4. After changes, redeploy the target environment or restart local `npm run dev`.
5. For local development, run `vercel env pull .env.local --yes` after dashboard changes, then re-add any local-only overrides that were not stored in Vercel.

## Domain Authentication

Use a verified domain sender before production traffic.

1. In Resend, add the sender domain used by `FROM_EMAIL`.
2. Add the DNS records Resend provides for domain authentication. This normally includes DKIM and SPF-related records.
3. Add or confirm a DMARC record for the sender domain according to the domain owner's policy. Use an enforcement level approved by the business/domain owner.
4. Wait for DNS propagation and confirm the domain is verified in Resend.
5. Send a staging test email from the exact `FROM_EMAIL` value.
6. Record only the domain verification status and redacted Resend message ID/status.

Production stop conditions:

- `FROM_EMAIL` is not on a verified domain.
- `RESEND_API_KEY` is missing from the Production environment.
- The production sender domain fails Resend verification.
- DNS/authentication evidence cannot be confirmed by the domain owner/operator.

## Profile Image And Sender Avatar

There are two separate ways an image can appear in email:

1. **Inside the email body.** Set `EMAIL_PROFILE_IMAGE_URL` to a public HTTPS image URL. The app adds it to the header area of Resend transactional email HTML. Use a square image so the circular crop looks intentional.
2. **As the inbox sender avatar.** Resend does not provide a send-API field that forces Gmail, Outlook, Apple Mail, or other clients to show a profile picture beside the sender. That image is controlled by the recipient's email provider.

For inbox avatars, configure one or more provider/domain-level options outside the app:

- A profile/logo on the mailbox or workspace that owns the exact `FROM_EMAIL`, where supported.
- Apple Branded Mail for Apple Mail inbox branding.
- BIMI for broader domain-level brand indicators. BIMI requires DNS setup and an approved SVG logo; some mailbox providers also require a Common Mark Certificate or Verified Mark Certificate.

If a specific email needs an inline image attachment instead of a hosted URL, Resend supports `cid:` inline attachments by adding an attachment with `content_id` and referencing it from the HTML. The current app uses the simpler hosted-image path for the shared transactional header.

## Sender Separation

Keep transactional and marketing email operations separate.

- Use `FROM_EMAIL` only for operational/transactional messages generated by this app.
- Do not use checkout, booking, or private form flows to build marketing broadcasts.
- If Resend Contacts, Audiences, Broadcasts, Topics, or suppression features are enabled later, document the legal basis, consent source, unsubscribe handling, and owner before sending any marketing email.
- Do not import customer/payment/private DB records into Resend Contacts for marketing unless the business/privacy owner has approved the workflow.

## Resend Dashboard Configuration

Recommended manual checks:

1. API key: create a key with the narrowest practical permission for sending email from this app.
2. Sender: confirm `FROM_EMAIL` uses the verified transactional domain.
3. Team access: restrict Resend dashboard access to operators who need delivery troubleshooting.
4. Logs: use Resend message IDs/status for troubleshooting, but redact addresses in launch evidence.
5. Templates: the app currently renders HTML in source. If Resend-hosted templates are introduced later, treat that as a code/design change and update tests/runbooks before switching live traffic.
6. Tracking: avoid enabling open/click tracking for transactional email unless the business/privacy owner approves the purpose and notice requirements.

## Delivery Recovery And Idempotency

The app records email state in private Postgres through `drizzle/0009_dashing_rocket_raccoon.sql`:

- `checkout_orders.product_confirmation_email_sent_at`
- `checkout_orders.product_confirmation_email_claimed_until`
- `checkout_orders.product_confirmation_email_last_error`
- `training_enrollments.student_payment_email_sent_at`
- `training_enrollments.training_email_claimed_until`
- `training_enrollments.training_email_last_error`
- `appointment_holds.booking_confirmation_email_sent_at`
- `appointment_holds.booking_confirmation_email_claimed_until`
- `appointment_holds.booking_confirmation_email_last_error`

Apply this migration through `docs/private-database-migration-runbook.md` before relying on payment email recovery in staging or production.

Expected behavior:

- Payment/webhook retries may try to claim an unsent email.
- A claimed email has a short lease so another retry does not send at the same time.
- Success records the `*_sent_at` timestamp and clears the claim/error field.
- Failure clears the claim, stores the last error, and logs for operator follow-up.
- A failed email does not roll back an already persisted booking, product order, training enrollment, or payment event.

### Manual retry endpoint

Operators can manually retry payment-related transactional email through the server-only admin endpoint after confirming the private DB record is valid and the original payment/booking state should remain in place.

`EMAIL_RETRY_SECRET` enables the endpoint. If the secret is missing, `/api/admin/email-retries` returns `404` so the manual retry surface is disabled by default.

Use either `Authorization: Bearer <EMAIL_RETRY_SECRET>` or `x-lash-email-retry-secret: <EMAIL_RETRY_SECRET>` with one of these request bodies:

```bash
curl -X POST "https://<deployment>/api/admin/email-retries" \
  -H "Authorization: Bearer $EMAIL_RETRY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"flow":"product","orderId":"<public-order-id>"}'

curl -X POST "https://<deployment>/api/admin/email-retries" \
  -H "Authorization: Bearer $EMAIL_RETRY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"flow":"training","orderId":"<public-order-id>"}'

curl -X POST "https://<deployment>/api/admin/email-retries" \
  -H "Authorization: Bearer $EMAIL_RETRY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"flow":"booking","orderId":"<payment-order-id>"}'
```

Expected responses:

- `200` with `{"status":"processed"}` when the retry path completes, or `{"status":"skipped"}` when no retryable training enrollment is available.
- `400` for malformed `flow`/`orderId` input.
- `401` for missing or incorrect retry secret.
- `404` when `EMAIL_RETRY_SECRET` is not configured.
- `503` when the retryable email send fails again. Check Vercel logs and the private DB `*_last_error` field before retrying.

Do not paste raw email addresses, payment data, full order payloads, or secrets into command history, tickets, docs, or chat. Record only the redacted order/hold identifier, flow, response status, and redacted Resend message/status evidence.

## Webhooks And Deferred Work

Resend delivery-status webhooks are not implemented in this app yet. Current operational state is based on successful Resend API acceptance plus the private `*_sent_at` fields. If the business needs bounce/complaint/suppression automation, add a signed Resend webhook route as a separate implementation with tests and privacy review.

Until then:

1. Use Resend dashboard logs for bounce/failure triage.
2. Record only redacted message IDs/statuses in evidence.
3. Manually follow up with affected customers if an operational email fails.
4. Keep suppression and unsubscribe policy decisions in the privacy/compliance checklist before any marketing workflow is added.

## Staging Smoke Checklist

After environment variables and migration are in place:

1. Submit a general inquiry and confirm the admin notification is accepted by Resend.
2. Submit a training contact form and confirm the admin notification is accepted by Resend.
3. Submit the contact popup form and confirm the admin notification is accepted by Resend.
4. Complete a staging product checkout and confirm product email state is marked sent in private DB.
5. Complete a staging paid training checkout and confirm both customer and admin email state are marked sent.
6. Complete a staging paid service booking and confirm booking confirmation email state is marked sent.
7. Retry the relevant browser validation or webhook path and confirm duplicate sends are not recorded.
8. Record Resend message IDs/statuses, verified-domain evidence, and DB sent-state evidence with addresses and customer details redacted.

## Troubleshooting

If email does not send:

1. Confirm `RESEND_API_KEY`, `FROM_EMAIL`, and `ADMIN_EMAIL` are present in the target Vercel environment.
2. Confirm the deployment was restarted/redeployed after env changes.
3. Confirm `FROM_EMAIL` is on a verified Resend domain.
4. Check Vercel logs for the relevant `[booking-email]`, `[product-email]`, `[checkout]`, or webhook error.
5. Check the private DB `*_last_error` field for the affected order, enrollment, or hold.
6. If `EMAIL_RETRY_SECRET` is configured, retry the affected `product`, `training`, or `booking` flow through `/api/admin/email-retries`.
7. Check Resend logs for the redacted message ID/status.
8. Do not revert the private payment/booking state solely because email failed; send a manual operational follow-up if needed.
