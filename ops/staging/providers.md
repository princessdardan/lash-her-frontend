# Staging provider configuration

Google Identity/Calendar and Resend isolation are configured. Square, Sanity and
Resend have separate protected webhook bindings, all disabled. No application
was deployed, no cloud application migration ran, and no email or provider test
event was sent. P1-02 remains open for the release and remaining platform gates.

[providers.json](providers.json) records configuration;
[google-oauth.json](google-oauth.json), [resend-isolation.json](resend-isolation.json)
and [webhook-registrations.json](webhook-registrations.json) record resource IDs and
verified state. Credential values and credential-bearing URLs stay outside Git.

| Provider | Applied configuration | Remaining verification |
| --- | --- | --- |
| Google Identity | New project `lash-her-staging-20261022` (`185770842371`); dedicated web client; origin `https://staging.lashher.com`; callback `/api/auth/callback/google`; staging-only environment binding | Deployed sign-in, callback/cookie behavior and administrator authorization |
| Google Calendar | Separate web client in the new project; only callback `https://staging.lashher.com/api/booking/oauth/callback`; Calendar API enabled | Connect the designated test account from staging admin, verify encrypted token storage and test Calendar flow |
| Resend | Separate `dardanlashher` account; approved Full access key; verified `mail.staging.lashher.com`; empty marketing segment; 11 published source-defined templates; disabled `contact.updated` webhook | Deployed recipient allowlist, isolated contact/unsubscribe flow, valid/invalid Svix signatures and duplicates |
| Square | Sandbox location `LE2H76M5V90AM`; disabled subscription; exact private notification URL and provider signing key installed as sensitive staging variables | Deployed ingress/HMAC and reconciliation checks; review legacy enabled preview callback before generating sandbox events |
| Sanity | Separate project `7o23yrvk`, dataset `staging-2026-05-10`; disabled editorial create/update/delete webhook; private bypass header | Deployed signature/cache/stock synchronization checks |
| Mux | Separate staging environment and Course webhook plan prepared | Isolated media credentials, Course gateway origin, signed webhook and playback verification |

## Google access

The user replaced the earlier existing-project choice with a new project under
the designated staging Google account. Project `87626194287` and its clients were not changed.
No billing account was attached by this work. The user approved Cloud terms,
OAuth User Data Policy, the two clients and Calendar API product terms separately.

The consent application remains External / Testing. Its saved project-wide scope
set is `openid`, `userinfo.email`, `userinfo.profile`, `calendar.events` and
`calendar.calendarlist.readonly`. Application code requests Identity and Calendar
scopes separately; the console consent declaration is shared by both clients.

The four approved OAuth test users were saved in the console and private operator
handoff. Only the designated staging account is in `ADMIN_OWNER_EMAILS` and is the
test Calendar owner. Public metadata records counts and an administrator-set hash;
individual test-user addresses are excluded from these repository documents.
No Calendar connection, refresh token or event was created.
Do not connect production calendars or reuse production refresh tokens.

Google's initial Identity secret appeared in a tool output through its copy-button
label. It was replaced before installation; the initial secret is disabled and
retained only as a disabled console entry. The installed replacement and Calendar
secret were captured privately. Google notes that changes may take time to propagate.
Both client secrets are sensitive variables only in the dedicated staging project.

## Resend isolation

The independent account boundary was verified through the approved key: its key
list contains the new staging key and excludes the previous production-team staging
key. It had zero domains, contacts and webhooks before configuration. No production
contacts, segments, templates or messages were imported. The 11 staging templates
were generated from repository source and read back as published.

The approved key has Full access because Resend offers no contact-only scope.
It is installed only in the staging project's Production and Preview targets.
The previous production-team sending credential was replaced in those targets;
no production-team key or data was deleted. A paid second team was not purchased.

Sender: `Lash Her Staging <staging@mail.staging.lashher.com>`.
Admin recipient and sole delivery allowlist entry: `delivered@resend.dev`.
Four new DNS verification records were added under `mail.staging.lashher.com`;
existing records were retained. Sending is enabled for that verified domain,
receiving and open/click tracking are disabled. No email has been sent.

The contact webhook was created in the empty isolated account and immediately
set to `disabled`, then read back. Resend's create API has no disabled flag.
Its private query URL carries a separate approved Vercel bypass token, and its
provider-issued signing secret is a sensitive staging variable. The bypass token
is not selected for deployment environment exposure.

## Ingress and release gates

[webhook-ingress.md](webhook-ingress.md) records the approved scope and rotation
procedure. The three credentials are project-wide, not path-scoped; application
signatures remain required. All-deployment Vercel Authentication remains enabled.
Only Square supplies the mandatory `VERCEL_AUTOMATION_BYPASS_SECRET`; Sanity and
Resend remain outside deployment environments. Provider/platform logs may retain
credential-bearing URLs. Square's source diagnostics now redact query credentials
while preserving exact-URL HMAC verification; this fix must ship before activation.

The legacy enabled Square sandbox webhook still targets
`https://preview.lashher.com/api/webhooks/square` with 153 event types. It was not
changed. Isolate or retire it through a reviewed change before sandbox test events.

Review and publish a source candidate, apply authorized protected migrations,
and set matching release/migration pins before the first deployment. The preflight
pins distinct OAuth client IDs, reviewed administrators, Resend sender/segment,
restricted recipients, isolated data resources and disabled shipping/CRM flags.
A configuration check does not certify deployed identity claims or provider flows.

After deployment, verify OAuth authorization, encrypted Calendar credentials,
valid/invalid/duplicate signatures, editorial create/update/delete, isolated email
contact flows and sandbox reconciliation before enabling webhook delivery.
Shipping, HighLevel and new service-booking payments remain disabled.

Sources checked 2026-10-22:
[Google credentials](https://developers.google.com/workspace/guides/create-credentials),
[Resend domains](https://resend.com/docs/api-reference/domains/create-domain),
[Resend webhooks](https://resend.com/docs/api-reference/webhooks/create-webhook),
[Resend disabled status](https://resend.com/docs/api-reference/webhooks/update-webhook),
[Vercel bypass scope](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation).
