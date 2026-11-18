# HighLevel CRM integration

## Implementation and release status

CRM capture and delivery are enabled in production; marketing remains paused. The production HighLevel
location now has the LH Website folder, all 20 contact custom fields, all 10
source tags, four source-filtered smart lists, and six unpublished native workflow
drafts. No draft is approved for activation. See the dated
[account audit](highlevel-account-audit-2026-10-20.md) for applied configuration.
The original setup did not apply production migrations or install the runtime
OAuth application. See the course-signup incident below for subsequent repairs.

Production is bound to **Lash Her By Nataliea**, location
`vd09FLBpPLXuHb5Tnhn4`. Development and preview reject that location. Use a separate
test location **and database**; do not reuse entity mappings across locations.

The connected developer MCP is read-only. Its operation discovery filters out
workflow/configuration writes and workflow inspection. It cannot create the
runtime marketplace OAuth application or apply the setup manifest. The user supplied
authenticated browser access for native setup. Email uses a shared domain and no
phone number is configured. The separate developer portal requires its own sign-in.
The runtime OAuth installation is connected to the configured location. Sender
authentication, the aggregate sending gate, and native workflow execution remain
marketing release blockers; local tests cannot substitute for them.

## Course-signup incident - 2026-10-29

Production was deployed through the HighLevel application changes, but its database
was still at `0077_course_signup`. Migrations `0078_highlevel_crm` and
`0079_highlevel_marketing_ownership` were absent, including the submission outbox
trigger and SMS consent table. In addition to preventing CRM capture, the missing
SMS consent table could roll back a new signup with a usable phone number even
when SMS marketing was unchecked. Production Vercel environment metadata contained
no `HIGHLEVEL_*` settings, and no runtime OAuth installation existed.

Both existing migrations were tested on an isolated local database and applied
to production. The 53 retained course submissions (52 email identities) were
inventoried and queued as historical references. Recovery completed 51 submission
events. Two remain in identity review: one submitted phone belongs to a different
CRM email identity, and one belongs to a separate CRM contact without an email.
All 52 historical email identities have CRM mappings, but the two conflicting
submission profiles/notes must wait for manual reconciliation. Do not merge or
overwrite the existing phone owners automatically.

The adapter now adds a deduplicated course-signup note containing the course,
source path, and optional Instagram handle. Name, email, and phone use the existing
identity-safe contact projection. Course notes do not create inquiry opportunities
or require marketing permission.

OAuth installation also now uses `/v2/oauth/chooselocation` with the
`HIGHLEVEL_APP_VERSION_ID` shown in the app's generated installation link. The old
unversioned URL omitted that required private-app context. Configuration is checked
before persisting the short-lived installation state.

The private runtime app is `Lash Her Website CRM`, app/version ID
`6ae37a0d02073d9ed34a2fa1`. Its client secret and credential encryption key are
production Secret variables in Vercel. The OAuth token request pins API version
`v3`. An agency administrator receives a `Company` token under HighLevel's current
mandatory bulk-install model; changing the storefront's view does not change the
installer's account type. A sub-account user can install directly. For an agency
installer, the optional `HIGHLEVEL_AGENCY_INSTALLATION_ENABLED=true` path additionally
requires authorization for `oauth.write` and a configured `HIGHLEVEL_COMPANY_ID`.
It checks the returned company against that ID, exchanges the agency access token
at `/oauth/location-token` for only the configured location, and validates the
location, credentials, expiry, and original nine scopes before saving. Agency
credentials are discarded and never persisted. Refresh accepts only location
tokens. The verified Lash Her company is `cth4d1VVsA9e1t1WIYJl`. Do not bypass these
checks or substitute an agency token in the database. See HighLevel's
[distribution model](https://marketplace.gohighlevel.com/docs/oauth/AppDistribution/)
and [location-token exchange](https://marketplace.gohighlevel.com/docs/ghl/oauth/get-location-access-token/).

The app remains private and unlisted, with both agency and sub-account installers
permitted. Its saved default webhook URL is
`https://lashher.com/api/webhooks/highlevel`; `ContactDndUpdate` and `ContactDelete`
are enabled. HighLevel sends app-uninstall events to the default URL automatically
([SDK webhook documentation](https://github.com/GoHighLevel/highlevel-api-sdk#webhooks)).
The receiver verifies signatures and the configured location before processing.

A production browser smoke test submitted a clearly identified synthetic contact
with both marketing choices unchecked. Course access unlocked, PostgreSQL retained
the profile and atomic outbox event, and HighLevel returned the matching full name,
phone, course source tag, and exactly one note with the course, source path, and
Instagram. Both CRM marketing eligibility fields remained `no`. The recovery queue
finished with 108 successful events and the two identity conflicts in review; no
retry, dead-letter, queued, or processing events remained. There are 53 mapped
identities including this synthetic test contact. CRM sync and the account audit
gate are enabled; marketing, workflow approval, and tracking remain paused, with
Resend retaining marketing ownership.

Consent events can create an email-only CRM mapping before the course event adds
its phone. The adapter now checks phone ownership again before adding it to a
mapped contact. This catches both conflicting-email and missing-email phone owners
as `identity_conflict` before a provider write, rather than surfacing a generic
HTTP 400. Original private submissions remain available for reconciliation.

Recover only course signups with the intended database environment securely loaded:

```sh
npm run crm:backfill -- --dry-run --course-signups-only
npm run crm:backfill -- --apply --course-signups-only
```

This scope excludes other submission types, orders, and enrollments from import,
while still detecting phone conflicts across all retained sources. Recovery imports
existing email evidence and current withdrawals for course identities, never infers
SMS permission, uses stable event keys, and marks jobs historical to prevent nurture
admission. Repeating the command is safe. New submissions enqueue atomically through
the database trigger, independently of optional marketing choices.

After configuring credentials and connecting the runtime app, use
`npm run crm:check -- --crm-only` to validate the OAuth connection and contact field
mapping independently of optional workflow and pipeline setup. This reports whether
sync is enabled; it does not enable it. The default `crm:check` still checks workflows
and pipelines. Marketing activation remains a separate release step.

## Ownership and capture

- PostgreSQL retains original submissions, channel consent evidence, commerce,
  source references, delivery ownership, OAuth credentials, and the CRM queue.
- HighLevel owns contact management, opportunities, staff follow-up, marketing
  delivery, reply handling, and the native sending policy.
- Resend retains transactional delivery, prior campaign history, old unsubscribe
  links/webhooks, and popup jobs already assigned to it before cutover.
- Sanity remains public content only. Square, Fresha, and the Course/Community
  services retain their existing responsibilities. No legacy booking route opens.

Migrations `0078_highlevel_crm.sql` and `0079_highlevel_marketing_ownership.sql`
install reference-only outbox triggers in the same transaction as submission,
consent, order, refund, shipment, and training-enrollment changes. A CRM outage
does not make a saved submission or purchase fail. Schema availability is required:
apply migrations before rolling out application code.

The version-1 queue envelope contains event ID/key, entity type/ID, event type,
occurrence time, and historical flag. Workers reload current records and consent;
old jobs cannot reinstate an old grant. The five-minute lease is claimed one job at
a time using `FOR UPDATE SKIP LOCKED`. The one-minute cron starts up to twenty jobs
within its time budget. Retryable failures back off, honor `Retry-After`, and reach
dead letter after eight attempts. Identity/configuration failures and ambiguous
provider effects enter review.

Source coverage includes general/training inquiries with no marketing permission,
popup/course signups, existing booking choices, product orders, training enrollments,
refunds, and cancellations. Failed/pending/authorization-only orders retain their
actual state. Product nurture requires dispatch/delivery; training nurture requires
a paid enrollment. Refunds stop journeys. Only an exactly matching website-created
training opportunity still in its configured initial stage can be closed as won.
Staff-moved deals and the LDA pipeline remain untouched. Historical inquiries create
contact history notes without opening new follow-up tasks or opportunities.
Historical commerce cannot stop newer journeys or close current opportunities;
current consent suppression still applies. Retried sales journeys are skipped when
a paid/refunded order's payment time is at or after the originating submission.
Legacy orders without a payment timestamp use their creation time. New inquiries
after a purchase remain eligible. Carrier-accepted and in-transit shipments qualify
as confirmed dispatch; creating a shipping label alone does not.

Contact identity uses normalized email and a separate phone lookup. Conflicts are
held for review instead of merged. Only missing profile fields are filled; unrelated
tags are preserved through additive tag operations. SMS is evaluated for the exact
normalized destination. Native workflows must compare the eligibility destination
field with the contact's current email/phone before sending, including after staff edits.

Only approved website fields are synchronized. Notes include the general inquiry
message, capped at 4,000 characters, and program/course/source context. Course notes
also include the optional Instagram handle. Booking intake
answers, payment tokens, authentication credentials, addresses, and detailed
financial ledgers are excluded. Lifecycle fields contain bounded order summaries.
Attribution contains only available `utm_*` campaign fields from the form URL; no
browser tracking or historical attribution is invented.

## Consent and suppression

Email and SMS controls are independent and initially unchecked. SMS requires a
usable phone number. Email-only popup visitors see no phone field until selecting
SMS. Course access remains independent of either choice and of CRM availability.
An unchecked choice records no new permission, rather than withdrawing an existing
grant. Existing signed website unsubscribe links still withdraw email permission.
SMS STOP/DND is handled through HighLevel and mirrored into the channel ledger.

`POST /api/webhooks/highlevel` verifies the raw-body Ed25519 `X-GHL-Signature`, checks
location, and deduplicates receipts. Timestamped older events cannot clear later
suppression. Equal timestamps retain the stricter state; undated events can suppress
but cannot clear a known block. Clearing DND does not insert an opt-in. Website DND
acknowledgements are not treated as a second withdrawal.

Suppression updates contain only the channels being blocked; they never replay
unrelated DND settings from an earlier contact read. A changed CRM phone still
requires identity review, but an email withdrawal is applied when the mapped
provider ID, location, and email destination are unchanged.

The application deliberately does **not** clear provider DND. A new website opt-in
is saved, but an existing provider block remains effective until its origin is
resolved in HighLevel. In particular, carrier-level SMS STOP requires the provider's
supported resubscription process. Include email re-consent reconciliation in the live
test matrix; do not activate marketing while legitimate email re-consent is stranded.

## OAuth and environment setup

1. Create a separate, location-level marketplace OAuth application. Add the exact
   HTTPS callback `/api/admin/highlevel/callback` and webhook
   `/api/webhooks/highlevel`. Subscribe to `ContactDndUpdate`, `ContactDelete`, and
   app uninstall. Keep developer MCP credentials separate.
2. Grant `contacts.readonly`, `contacts.write`, `opportunities.readonly`,
   `opportunities.write`, `workflows.readonly`, `locations.readonly`,
   `locations/customFields.readonly`, `locations/tags.readonly`, and `users.readonly`.
   Agency-admin installation additionally requires explicit authorization for
   `oauth.write`, `HIGHLEVEL_AGENCY_INSTALLATION_ENABLED=true`, and the expected
   `HIGHLEVEL_COMPANY_ID`. Leave that optional path disabled for direct sub-account
   installation. `oauth.write` also permits managing app installations.
   Runtime code does not provision schemas, workflows, sending numbers, or domains.
3. Configure the server-only variables documented in `.env.local.example`.
   `HIGHLEVEL_CREDENTIAL_ENCRYPTION_KEY` is a random 32-byte key encoded as 64 hex
   characters. Keep it stable and backed up. It protects location-bound AES-GCM
   token envelopes and derives irreversible privacy tombstones. Key rotation requires
   a planned token/tombstone migration, not replacing this value in isolation.
4. In `/admin/marketing/highlevel`, connect as an authorized administrator.
   Installation state is short-lived, single-use, and bound to that administrator.
   Wrong-location and missing-scope token exchanges fail closed. Token refresh has a
   durable single-writer claim. A lost refresh response requires reconnecting; the
   app never blindly replays a possibly consumed refresh token.
5. Apply [the setup manifest](./highlevel-setup-manifest.json) in the test location,
   then separately in production. Record the actual field IDs in `HIGHLEVEL_FIELD_IDS`
   and pipeline/stage/workflow IDs in the corresponding environment variables.
   Production pipeline IDs are in the manifest; test IDs will differ.
6. With the intended environment securely loaded, run `npm run crm:check`.
   This read-only check validates field IDs, pipeline/stage mappings, and workflow
   presence/status. It does not prove sender delivery or workflow cadence.

## Cutover procedure

1. Apply the migrations with the normal target/host guards. Keep
   `HIGHLEVEL_SYNC_ENABLED=false`, `HIGHLEVEL_MARKETING_ENABLED=false`,
   `HIGHLEVEL_WORKFLOWS_REVIEWED=false`, and `MARKETING_DELIVERY_PROVIDER=resend`.
2. Audit existing HighLevel contact-created, tag, pipeline, and import automations.
   Confirm duplicate settings and ensure importing a contact or setting a field
   cannot enroll it into marketing. Verify email authentication, monitored replies,
   SMS sender registration and usable numbers. Set `HIGHLEVEL_ACCOUNT_AUDITED=true`
   only after this audit.
3. Run `npm run crm:backfill -- --dry-run` against the intended database. It prints
   counts only and makes no writes. Review identities and conflicting retained phone
   matches. `npm run crm:backfill -- --apply` imports supported email evidence and
   current suppression, then enqueues historical references with stable keys.
   Re-running it does not duplicate effects. It never infers SMS permission.
4. Enable CRM synchronization while Resend still owns marketing. Reconcile source
   counts, conflict/review items, consent restrictions, and last successful sync.
   New and historical jobs use the same adapter; historical jobs cannot admit nurture.
5. Build and review [the workflow drafts](./highlevel-workflow-drafts.md). Confirm
   the shared sending gate, reply/takeover/conversion stops, exact-destination consent,
   time windows, and sender behavior with designated test contacts.
6. Reconcile pending/scheduled Resend campaigns in Resend, then set
   `MARKETING_DELIVERY_PROVIDER=highlevel`. The website composer becomes read-only
   and server-side campaign sends are blocked. This switch does not cancel an already
   scheduled provider broadcast. Resolve those broadcasts before switching.
7. Popup offer rows retain their immutable provider assignment. Existing Resend rows
   drain through the existing worker; new HighLevel rows are excluded from that
   worker and enter the CRM queue. Both providers use the existing per-contact,
   per-promotion dedupe key, including key-rotation candidates. Repeated promotions
   do not create a second welcome admission across cutover. Generic welcomes are
   admitted at most once per mapped contact.
8. Set reviewed workflow IDs, `HIGHLEVEL_WORKFLOWS_REVIEWED=true`, and finally
   `HIGHLEVEL_MARKETING_ENABLED=true` only after live checks pass. Popup welcomes/offers
   assigned to HighLevel remain queued while marketing is paused. Other contacts collected during the disabled marketing period are not
   retroactively enrolled by replaying completed sync jobs. Review and deliberately admit any desired backlog.

Workflow admission is distinct from message delivery. A HighLevel-owned popup row
with a `workflow:` provider reference records an accepted workflow handoff; verify
the actual delivery in HighLevel. No code or test here establishes inbox/SMS delivery.

## Recovery and privacy

The admin page shows queue counts/oldest timestamps, failures, identity conflicts,
connection state, and last successful sync. Replay preserves the effect ledger.
Uncertain notes, tasks, opportunities, and workflow admissions require reviewing
the provider record/execution log. Record either a confirmed provider ID or a
verified absent outcome, then replay. Never resolve an outcome as absent while a
request is still in flight. This favors review over duplicate outreach.

`HIGHLEVEL_MARKETING_ENABLED=false` stops new admission and the cron cancels known
website admissions, ten contacts per run. This also runs when CRM sync is paused.
Pause native campaigns/workflows directly in HighLevel for an immediate account-wide
stop, especially during a provider outage. Keep the webhook endpoint active so
withdrawals continue to persist. Pausing never reactivates Resend campaigns.

Private-data retention now expires OAuth states, 90-day webhook receipts, 395-day
completed queue records, and seven-year channel evidence. It queues eligibility
refresh before evidence expiry. Source deletion/redaction queues CRM cleanup:
the expired source's website-owned note is removed. When another submission,
order, enrollment, or current channel grant remains, shared fields and eligibility
are recomputed from retained data without replaying admissions. Only journeys tied
to the removed entity are cancelled. Without a retained purpose, website fields
are cleared, journeys stopped, and contact-wide deletion is exposed for administrator
review because a CRM contact may contain staff-owned records. The reviewed deletion action deletes the provider contact and
channel evidence and replaces the local email with a keyed tombstone so queued
source events cannot recreate it. Complete source-system erasure separately.
Review/dead-letter jobs and deduplication ledgers are retained until reconciled.

## Verification evidence and remaining gates

Local implementation checks passed on an isolated PostgreSQL database: migrations,
1,996 project unit tests, seventeen focused database tests, TypeScript, and four
Chromium consent/course checks. Database coverage includes transaction rollback,
duplicate inquiry effects, uncertain acknowledgements, concurrent refresh, reordered
DND, historical reruns, provider ownership, lease fencing, paused welcome durability,
confirmed workflow removal, order reservation and training finalization.

Before release, record evidence for: every live source reaching the test location;
email/SMS withdrawal and re-consent; permanent STOP remaining blocked; invalid/wrong
tenant webhook rejection; provider 429/outage recovery; lost workflow acknowledgements;
one offer handoff across cutover; paid versus authorization/failed/refunded lifecycle;
overlapping native journeys and staff campaigns respecting the aggregate cadence;
reply/staff takeover stopping nurture; transactional receipts/course access; and
privacy cleanup. **Native workflow cadence, sender delivery, and live contact coverage
are not verified by the local test suite.**

Future Course API enrollment events should call the same outbox adapter from their
durable local projection, using the upstream event ID as the unique event key.
The Course API event contract/projection is not yet shipped; this integration does
not invent that contract or become the course entitlement authority.

## References

- [OAuth authorization](https://marketplace.gohighlevel.com/docs/Authorization/authorization_doc/)
- [Scopes](https://marketplace.gohighlevel.com/docs/Authorization/Scopes/)
- [Contact lookup](https://marketplace.gohighlevel.com/docs/ghl/contacts/lookup-contact/)
- [Contact upsert](https://marketplace.gohighlevel.com/docs/ghl/contacts/upsert-contact/)
- [Webhook verification](https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/)
- [Contact DND](https://marketplace.gohighlevel.com/docs/webhook/ContactDndUpdate/)
- [Workflow admission](https://marketplace.gohighlevel.com/docs/ghl/contacts/add-contact-to-workflow/)

## Independent website tracking

The [website tracking audit and release gate](highlevel-website-tracking.md) covers
separate version-2 browser consent. Legacy analytics choices do not authorize CRM
tracking. `HIGHLEVEL_TRACKING_ENABLED=false` is independent of synchronization,
marketing, workflows and delivery ownership; unresolved vendor safety requirements
also block activation in code even if that flag is set true. No embed, browser
identity bridge, duplicate submission path, or channel-consent mutation is installed.
