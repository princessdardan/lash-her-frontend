# Resend Dashboard Setup Tutorial

This tutorial walks through obtaining and configuring the Resend values this app needs for transactional templates, marketing contacts, segments/topics, automations, broadcasts, and unsubscribe webhooks.

Do not paste real API keys, webhook secrets, email addresses, payment data, or customer PII into tickets, docs, PRs, or chat. Keep every Resend value server-only; never use a `NEXT_PUBLIC_` prefix.

## Values You Will Collect

Required for staging/preview and production:

```env
RESEND_API_KEY=<api-key>
RESEND_WEBHOOK_SECRET=<webhook-signing-secret>
RESEND_SEGMENT_MARKETING_ID=<all-marketing-segment-id>
FROM_EMAIL=<verified-sender-address>
ADMIN_EMAIL=<admin-recipient-address>
```

Optional, but recommended when admins want dashboard-managed campaigns:

```env
RESEND_SEGMENT_BOOKING_ID=<segment-id>
RESEND_SEGMENT_CONTACT_POPUP_ID=<segment-id>
RESEND_SEGMENT_GENERAL_INQUIRY_ID=<segment-id>
RESEND_SEGMENT_SANITY_BACKFILL_ID=<segment-id>
RESEND_SEGMENT_TRAINING_CONTACT_ID=<segment-id>

RESEND_TOPIC_MARKETING_ID=<topic-id>
RESEND_TOPIC_NEWSLETTER_ID=<topic-id>
RESEND_TOPIC_TRAINING_ID=<topic-id>

RESEND_TEMPLATE_BOOKING_CONFIRMATION_ID=<template-id>
RESEND_TEMPLATE_CONTACT_POPUP_ADMIN_ID=<template-id>
RESEND_TEMPLATE_CONTACT_POPUP_CUSTOMER_ID=<template-id>
RESEND_TEMPLATE_GENERAL_INQUIRY_ADMIN_ID=<template-id>
RESEND_TEMPLATE_GENERAL_INQUIRY_CUSTOMER_ID=<template-id>
RESEND_TEMPLATE_PRODUCT_CONFIRMATION_ID=<template-id>
RESEND_TEMPLATE_TRAINING_CONTACT_ADMIN_ID=<template-id>
RESEND_TEMPLATE_TRAINING_CONTACT_CUSTOMER_ID=<template-id>
RESEND_TEMPLATE_TRAINING_PAYMENT_ADMIN_ID=<template-id>
RESEND_TEMPLATE_TRAINING_PAYMENT_CUSTOMER_ID=<template-id>

RESEND_EVENT_MARKETING_CONTACT_OPTED_IN=lashher.marketing_contact.opted_in
```

Optional for the shared transactional header image:

```env
EMAIL_PROFILE_IMAGE_URL=<public-https-profile-image-url>
```

## Step 1: Create Or Select The Resend Project

1. Sign in to Resend.
2. Confirm you are in the correct team/account for the target environment.
3. Use separate Resend API keys for staging and production when possible.
4. Record only the environment name and redacted key ID in launch evidence.

## Step 2: Verify The Sending Domain

1. Open **Domains** in the Resend Dashboard.
2. Add the domain used by `FROM_EMAIL`.
3. Add every DNS record Resend provides, including DKIM/SPF-related records.
4. Confirm the domain owner’s DMARC policy is acceptable for production.
5. Wait for Resend to show the domain as verified.
6. Set `FROM_EMAIL` to an address on the verified domain, for example `Lash Her <hello@example.com>`.
7. Set `ADMIN_EMAIL` to the operational recipient address for admin notifications.

Stop if the sender domain is not verified. Do not send production traffic from an unverified sender.

## Step 3: Create The API Key

1. Open **API Keys** in Resend.
2. Create a key for the target environment.
3. Use the narrowest practical permission set that still allows sending email and managing the Resend resources this app uses.
4. Copy the key once and store it as `RESEND_API_KEY` in the target Vercel environment.
5. Do not store the raw key in this repository.

## Step 4: Create Contact Segments

Segments are used for dashboard targeting and broadcast audiences.

1. Open **Contacts** or **Segments** in Resend.
2. Create a required all-marketing segment, for example `Lash Her - All Marketing Contacts`.
3. Copy its segment ID into `RESEND_SEGMENT_MARKETING_ID`.
4. Optionally create source-specific segments:
   - `Booking opt-ins` -> `RESEND_SEGMENT_BOOKING_ID`
   - `Contact popup leads` -> `RESEND_SEGMENT_CONTACT_POPUP_ID`
   - `General inquiry opt-ins` -> `RESEND_SEGMENT_GENERAL_INQUIRY_ID`
   - `Legacy Sanity backfill` -> `RESEND_SEGMENT_SANITY_BACKFILL_ID`
   - `Training inquiries` -> `RESEND_SEGMENT_TRAINING_CONTACT_ID`

The app creates/updates Resend contacts only after it has written private consent evidence. Non-opt-ins remain in the private database and are not synced to Resend as marketing contacts.

## Step 5: Create Topics For Unsubscribe Preferences

Topics let contacts unsubscribe from specific categories instead of only global marketing.

1. Open the Resend area for contact topics/preferences.
2. Create a general marketing topic and save its ID as `RESEND_TOPIC_MARKETING_ID`.
3. Optionally create:
   - Newsletter or offers topic -> `RESEND_TOPIC_NEWSLETTER_ID`
   - Training updates topic -> `RESEND_TOPIC_TRAINING_ID`
4. Keep topic names clear enough for admins to select them safely in broadcasts.

When configured, the app opts consenting contacts into the marketing topic plus a source-specific topic where applicable.

## Step 6: Create Dashboard Templates

Templates are optional. If a template ID is not configured, the app uses its source-rendered HTML fallback.

1. Open **Templates** in Resend.
2. Create one template per flow you want admins to manage in the dashboard.
3. Publish the template before using it in staging or production.
4. Copy each template ID into the matching env var:

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

Use uppercase variables in templates, such as `CUSTOMER_NAME`, `CUSTOMER_FIRST_NAME`, `CUSTOMER_EMAIL`, `ORDER_ID`, `PROGRAM_TITLE`, `SOURCE_PATH`, `EMAIL_PROFILE_IMAGE_HTML`, and flow-specific fields. Keep `{{{EMAIL_PROFILE_IMAGE_HTML}}}` in the header where the app-managed profile image should appear; the app fills it from `EMAIL_PROFILE_IMAGE_URL` at send time. Test in staging before setting production template IDs.

## Step 7: Create The Resend Webhook

The app webhook endpoint is:

```text
https://<deployment-domain>/api/webhooks/resend
```

Create one webhook per environment.

1. Open **Webhooks** in Resend.
2. Create a new webhook endpoint.
3. Set the endpoint URL to the staging or production deployment URL plus `/api/webhooks/resend`.
4. Subscribe to `contact.updated` events.
5. Save the webhook.
6. Copy the webhook signing secret and store it as `RESEND_WEBHOOK_SECRET` in the same Vercel environment.

The app verifies Resend webhook requests using the raw request body and the Svix headers Resend sends:

- `svix-id`
- `svix-timestamp`
- `svix-signature`

Expected behavior:

- Missing `RESEND_WEBHOOK_SECRET` -> endpoint returns `404`.
- Missing or invalid Svix headers -> endpoint returns `401`.
- `contact.updated` with `unsubscribed: true` -> app records a private unsubscribe consent event.
- Persistence failure -> endpoint returns `503` so Resend can retry.

## Step 8: Configure Automations

1. Open **Automations** in Resend.
2. Create an automation triggered by the opt-in event.
3. Use this default event unless you intentionally override it:

```env
RESEND_EVENT_MARKETING_CONTACT_OPTED_IN=lashher.marketing_contact.opted_in
```

4. Add steps such as adding/removing segments, sending a welcome sequence, or notifying staff.
5. Test the automation in staging with a real opted-in form submission.

## Step 9: Configure Broadcasts

1. Open **Broadcasts** in Resend.
2. Create broadcasts against the configured marketing/source segments and topics.
3. Do not use raw payment/customer exports as broadcast audiences.
4. Include Resend’s unsubscribe placeholder or dashboard unsubscribe block in marketing email content.
5. Send test broadcasts to internal recipients before scheduling any customer-facing campaign.

For custom HTML marketing templates, include Resend’s unsubscribe placeholder:

```handlebars
{{{RESEND_UNSUBSCRIBE_URL}}}
```

## Step 10: Add Values To Vercel

For each environment:

1. Open the Vercel project settings.
2. Add the required Resend variables as server-only environment variables.
3. Scope staging values to Preview/Development and production values to Production.
4. Add optional template/segment/topic/event variables only after the matching Resend resource exists.
5. Redeploy the target environment after changing env vars.

Never add Resend keys or webhook secrets as `NEXT_PUBLIC_*` variables.

## Step 11: Local Development Setup

For local development:

1. Pull Vercel variables if needed:

```bash
vercel env pull .env.local --yes
```

2. Add local-only overrides manually.
3. Restart `npm run dev` after changing env vars.
4. Do not commit `.env.local`.

## Step 12: Verify The Setup

Run these checks after configuring staging:

1. Run environment validation:

```bash
VERCEL_ENV=preview node scripts/validate-sanity-env.mjs
```

2. Submit an opted-in general inquiry and confirm:
   - Private DB consent evidence exists.
   - The contact appears in Resend.
   - The contact is in `RESEND_SEGMENT_MARKETING_ID`.
3. Submit a contact popup and confirm optional source segment/topic assignment if configured.
4. Trigger a test unsubscribe in Resend and confirm the private consent ledger records an unsubscribe.
5. Send a staging transactional email for a configured dashboard template and confirm Resend accepted the message.
6. Remove one optional template ID and confirm the fallback HTML path still sends.
7. Record only redacted message IDs, resource IDs, and pass/fail evidence.

## Troubleshooting

If email does not send:

1. Confirm `RESEND_API_KEY`, `FROM_EMAIL`, and `ADMIN_EMAIL` are present in the target environment.
2. Confirm the sender domain is verified.
3. Confirm the deployment was restarted after env changes.
4. Check Vercel logs for email errors.

If contacts do not sync:

1. Confirm the user explicitly opted into marketing.
2. Confirm `RESEND_SEGMENT_MARKETING_ID` exists in Resend.
3. Confirm `RESEND_API_KEY` has permission to manage contacts/segments/topics/events.
4. Check Vercel logs for `[marketing-contact] Resend contact sync failed`.

If unsubscribes do not sync back:

1. Confirm the Resend webhook endpoint URL is correct for the environment.
2. Confirm the webhook subscribes to `contact.updated`.
3. Confirm `RESEND_WEBHOOK_SECRET` matches the webhook signing secret.
4. Confirm Resend is sending `svix-id`, `svix-timestamp`, and `svix-signature` headers.
5. Check Vercel logs for `[resend-webhook]` warnings or errors.
