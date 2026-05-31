# Resend Email, Contacts, Templates, And Broadcast Setup

This runbook covers manual Resend and Vercel setup for Lash Her email operations. The application sends customer/admin operational email through Resend after private database writes for forms, product checkout, paid training, and paid service booking. It also syncs opted-in marketing contacts to Resend Contacts so admins can manage segments, topics, automations, broadcasts, and unsubscribes in the Resend Dashboard.

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
RESEND_WEBHOOK_SECRET=<resend-webhook-signing-secret>
RESEND_SEGMENT_MARKETING_ID=<all-marketing-segment-id>
FROM_EMAIL=<verified-transactional-sender-address>
ADMIN_EMAIL=<admin-recipient-address>
EMAIL_PROFILE_IMAGE_URL=<optional-public-https-profile-image-url>
EMAIL_RETRY_SECRET=<long-random-manual-retry-secret>

# Optional Resend Dashboard templates. When omitted, source-rendered HTML fallback remains active.
RESEND_TEMPLATE_BOOKING_CONFIRMATION_ID=<optional-template-id>
RESEND_TEMPLATE_CONTACT_POPUP_ADMIN_ID=<optional-template-id>
RESEND_TEMPLATE_CONTACT_POPUP_CUSTOMER_ID=<optional-template-id>
RESEND_TEMPLATE_GENERAL_INQUIRY_ADMIN_ID=<optional-template-id>
RESEND_TEMPLATE_GENERAL_INQUIRY_CUSTOMER_ID=<optional-template-id>
RESEND_TEMPLATE_PRODUCT_CONFIRMATION_ID=<optional-template-id>
RESEND_TEMPLATE_TRAINING_CONTACT_ADMIN_ID=<optional-template-id>
RESEND_TEMPLATE_TRAINING_CONTACT_CUSTOMER_ID=<optional-template-id>
RESEND_TEMPLATE_TRAINING_PAYMENT_ADMIN_ID=<optional-template-id>
RESEND_TEMPLATE_TRAINING_PAYMENT_CUSTOMER_ID=<optional-template-id>

# Optional source-specific contact segmentation.
RESEND_SEGMENT_BOOKING_ID=<optional-segment-id>
RESEND_SEGMENT_CONTACT_POPUP_ID=<optional-segment-id>
RESEND_SEGMENT_GENERAL_INQUIRY_ID=<optional-segment-id>
RESEND_SEGMENT_SANITY_BACKFILL_ID=<optional-segment-id>
RESEND_SEGMENT_TRAINING_CONTACT_ID=<optional-segment-id>

# Optional topic preferences for finer unsubscribe controls.
RESEND_TOPIC_MARKETING_ID=<optional-topic-id>
RESEND_TOPIC_NEWSLETTER_ID=<optional-topic-id>
RESEND_TOPIC_TRAINING_ID=<optional-topic-id>

# Optional automation event name. Defaults to lashher.marketing_contact.opted_in.
RESEND_EVENT_MARKETING_CONTACT_OPTED_IN=<optional-event-name>
```

`EMAIL_PROFILE_IMAGE_URL` is optional. When set, the app renders that public HTTPS image as a small circular profile mark inside the HTML header of transactional emails. It is not a secret and must be reachable by email clients without authentication.

Vercel setup:

1. Add the required variables in the Vercel project settings for the intended environment, and add `EMAIL_PROFILE_IMAGE_URL` only when the transactional header image should be enabled.
2. Scope staging/preview values to Preview and local Development; scope production values to Production only.
3. Use separate Resend API keys for staging and production if the Resend account policy allows it.
4. After changes, redeploy the target environment or restart local `npm run dev`.
5. For local development, run `vercel env pull .env.local --yes` after dashboard changes, then re-add any local-only overrides that were not stored in Vercel.

`RESEND_WEBHOOK_SECRET` and `RESEND_SEGMENT_MARKETING_ID` are required for preview/production environment validation. Source-specific segments, topics, and template IDs are optional so admins can roll them out without losing the source-rendered fallback emails.

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
- Sync only affirmative marketing consent records into Resend Contacts. Non-opt-ins remain in the private database consent ledger and are not created as Resend marketing contacts by this app.
- Do not use checkout, booking, or private form flows to build marketing broadcasts unless the submitted consent choice was affirmative.
- Broadcasts must target the configured marketing/source segments and topics, not raw payment/customer exports.
- Do not import customer/payment/private DB records into Resend Contacts for marketing unless the business/privacy owner has approved the workflow and consent source.

## Resend Dashboard Configuration

Recommended manual checks:

1. API key: create a key with the narrowest practical permission for sending email from this app.
2. Sender: confirm `FROM_EMAIL` uses the verified transactional domain.
3. Team access: restrict Resend dashboard access to operators who need delivery troubleshooting.
4. Logs: use Resend message IDs/status for troubleshooting, but redact addresses in launch evidence.
5. Templates: create/publish dashboard templates before setting the matching `RESEND_TEMPLATE_*_ID` variable. The app falls back to source-rendered HTML while a variable is absent.
6. Contacts: create an all-marketing segment and set `RESEND_SEGMENT_MARKETING_ID`. Create optional source-specific segments and topics when admins need finer broadcast targeting or preference controls.
7. Webhooks: create a webhook for `contact.updated` events pointing at `/api/webhooks/resend`, then set the signing secret as `RESEND_WEBHOOK_SECRET`.
8. Automations and broadcasts: use Resend segments/topics and the opt-in event to build dashboard-managed marketing journeys; do not hard-code those campaigns in app source.
9. Tracking: avoid enabling open/click tracking for transactional email unless the business/privacy owner approves the purpose and notice requirements.

## Resend Dashboard Templates

Admins can manage transactional email copy in Resend Templates. The code keeps a source-rendered HTML fallback for every flow, so template rollout is controlled by environment variables:

| Flow | Env var |
| --- | --- |
| Booking confirmation | `RESEND_TEMPLATE_BOOKING_CONFIRMATION_ID` |
| Contact popup admin notification | `RESEND_TEMPLATE_CONTACT_POPUP_ADMIN_ID` |
| Contact popup customer reply | `RESEND_TEMPLATE_CONTACT_POPUP_CUSTOMER_ID` |
| General inquiry admin notification | `RESEND_TEMPLATE_GENERAL_INQUIRY_ADMIN_ID` |
| General inquiry customer reply | `RESEND_TEMPLATE_GENERAL_INQUIRY_CUSTOMER_ID` |
| Product order confirmation | `RESEND_TEMPLATE_PRODUCT_CONFIRMATION_ID` |
| Training contact admin notification | `RESEND_TEMPLATE_TRAINING_CONTACT_ADMIN_ID` |
| Training contact customer reply | `RESEND_TEMPLATE_TRAINING_CONTACT_CUSTOMER_ID` |
| Training payment admin notification | `RESEND_TEMPLATE_TRAINING_PAYMENT_ADMIN_ID` |
| Training payment customer confirmation | `RESEND_TEMPLATE_TRAINING_PAYMENT_CUSTOMER_ID` |

Template variables are sent as uppercase keys such as `CUSTOMER_NAME`, `CUSTOMER_FIRST_NAME`, `CUSTOMER_EMAIL`, `ORDER_ID`, `PROGRAM_TITLE`, `SOURCE_PATH`, and flow-specific fields. Check the fallback HTML for each flow before editing templates so the dashboard copy preserves required operational content.

### Seed Dashboard Templates From Source Fallbacks

Use the template seeding tool when creating a new Resend environment or refreshing dashboard templates from the app's source-rendered fallback HTML.

Dry-run mode is the default and does not call Resend:

```bash
npm run resend:seed-templates
```

The dry run prints each template name, default subject, variable keys, and the `RESEND_TEMPLATE_*_ID` env var that should receive the returned Resend template ID.

Apply mode creates each template, publishes it, and prints copy-ready `.env` lines. Use a Resend API key with **Full access** for this one-time management operation; **Sending access** is not sufficient because the script calls the Templates API to create and publish templates.

```bash
read -rsp "Resend Full access API key: " RESEND_API_KEY
export RESEND_API_KEY
npm run resend:seed-templates -- --apply
unset RESEND_API_KEY
```

Apply mode requires `RESEND_API_KEY`, but it does not write secrets or returned IDs to disk and never updates `.env.local` automatically. Copy the printed values into the target environment only after reviewing the created templates in Resend. If you create a temporary Full access key for seeding, revoke it after copying the template UUIDs; runtime sending can use a narrower sending key when no Resend management APIs are needed.

The apply command intentionally spaces out Resend template create/publish calls to stay below Resend's default API rate limit. It prints each `RESEND_TEMPLATE_*_ID=<uuid>` line immediately after that template is published, so if a later request fails you can keep the IDs already printed and review/delete any partial duplicate templates in the Resend dashboard before rerunning.

Resend template IDs returned by the Templates API are UUIDs, for example `d9b7207a-730e-4050-9263-aa4031c3170c`. Copy the UUID exactly into the matching `RESEND_TEMPLATE_*_ID` variable. Do not prepend `tmpl_`.

The seeded templates remain normal Resend Dashboard templates after creation. Admins can edit and republish copy in the dashboard as long as they keep the triple-brace variables used by the app, such as `{{{CUSTOMER_NAME}}}`, `{{{ORDER_ID}}}`, and `{{{SCHEDULING_URL}}}`.

Do not remove legal/operational details from payment, booking, or training templates. Use Resend preview/testing against staging before setting a production template ID.

## Contacts, Segments, Topics, Automations, And Broadcasts

When a website form includes affirmative marketing consent, the app writes the private consent/submission record first and then syncs the contact to Resend. The Resend sync:

- Creates or updates the contact with `unsubscribed: false`.
- Adds the contact to `RESEND_SEGMENT_MARKETING_ID` and the optional source segment.
- Opts the contact into `RESEND_TOPIC_MARKETING_ID` and optional source topic when configured.
- Sends the automation event named by `RESEND_EVENT_MARKETING_CONTACT_OPTED_IN`, defaulting to `lashher.marketing_contact.opted_in`.

Recommended segment/topic setup:

| Consent source | Segment env var | Topic env var |
| --- | --- | --- |
| All marketing contacts | `RESEND_SEGMENT_MARKETING_ID` | `RESEND_TOPIC_MARKETING_ID` |
| Booking marketing opt-in | `RESEND_SEGMENT_BOOKING_ID` | none by default |
| Contact popup | `RESEND_SEGMENT_CONTACT_POPUP_ID` | `RESEND_TOPIC_NEWSLETTER_ID` |
| General inquiry | `RESEND_SEGMENT_GENERAL_INQUIRY_ID` | none by default |
| Training contact | `RESEND_SEGMENT_TRAINING_CONTACT_ID` | `RESEND_TOPIC_TRAINING_ID` |
| Sanity legacy backfill | `RESEND_SEGMENT_SANITY_BACKFILL_ID` | none by default |

Admins can create Resend Automations triggered by the configured opt-in event and can create Resend Broadcasts against the configured segments/topics. Marketing broadcast templates should include Resend's unsubscribe placeholder, `{{{RESEND_UNSUBSCRIBE_URL}}}`, or the equivalent dashboard unsubscribe block so Resend handles unsubscribe requests.

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

## Resend Webhook And Unsubscribe Sync

The app exposes `POST /api/webhooks/resend` for signed Resend webhooks. Configure the Resend Dashboard webhook with the deployment URL and subscribe to `contact.updated` events.

Implementation details:

- The route verifies the raw request body with `resend.webhooks.verify()` and the `svix-id`, `svix-timestamp`, and `svix-signature` headers.
- If `RESEND_WEBHOOK_SECRET` is absent, the route returns `404` so the endpoint is disabled by default.
- Invalid or missing signatures return `401` and do not touch the private database.
- `contact.updated` events with `unsubscribed: true` update the local marketing contact record and append an `unsubscribe` consent event with the Resend contact/segment metadata.
- Persistence failures return `503` so Resend can retry the webhook delivery.

Delivery-status, bounce, complaint, and suppression webhooks are not persisted yet. Use Resend dashboard logs for those operational events and record only redacted message IDs/statuses in launch evidence.

## Staging Smoke Checklist

After environment variables and migration are in place:

1. Submit a general inquiry and confirm the admin notification is accepted by Resend.
2. Submit a training contact form and confirm the admin notification is accepted by Resend.
3. Submit the contact popup form and confirm the admin notification is accepted by Resend.
4. Complete a staging product checkout and confirm product email state is marked sent in private DB.
5. Complete a staging paid training checkout and confirm both customer and admin email state are marked sent.
6. Complete a staging paid service booking and confirm booking confirmation email state is marked sent.
7. Submit an opted-in marketing form and confirm the contact appears in the configured Resend segment/topic.
8. Trigger a Resend `contact.updated` unsubscribe event from the dashboard/webhook tester and confirm the private consent ledger records an unsubscribe.
9. Retry the relevant browser validation or webhook path and confirm duplicate sends are not recorded.
10. Record Resend message IDs/statuses, verified-domain evidence, contact segment evidence, and DB sent-state evidence with addresses and customer details redacted.

## Troubleshooting

If email does not send:

1. Confirm `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_SEGMENT_MARKETING_ID`, `FROM_EMAIL`, and `ADMIN_EMAIL` are present in the target Vercel environment.
2. Confirm the deployment was restarted/redeployed after env changes.
3. Confirm `FROM_EMAIL` is on a verified Resend domain.
4. Check Vercel logs for the relevant `[booking-email]`, `[product-email]`, `[checkout]`, or webhook error.
5. Check the private DB `*_last_error` field for the affected order, enrollment, or hold.
6. If `EMAIL_RETRY_SECRET` is configured, retry the affected `product`, `training`, or `booking` flow through `/api/admin/email-retries`.
7. Check Resend logs for the redacted message ID/status.
8. If contacts are not segmented, confirm the segment/topic IDs exist in Resend and match the environment variables.
9. If unsubscribes are not syncing locally, confirm the Resend webhook is subscribed to `contact.updated`, `RESEND_WEBHOOK_SECRET` matches the dashboard signing secret, and Vercel logs do not show `[resend-webhook]` errors.
10. Do not revert the private payment/booking state solely because email failed; send a manual operational follow-up if needed.
