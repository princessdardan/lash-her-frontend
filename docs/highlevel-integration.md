# HighLevel CRM integration

## Implementation and release status

The website implementation is behind disabled flags. The production HighLevel
location now has the LH Website folder, all 20 contact custom fields, all 10
source tags, four source-filtered smart lists, and six unpublished native workflow
drafts. No draft is approved for activation. See the dated
[account audit](highlevel-account-audit-2026-10-20.md) for applied configuration.
No production migration, contact import, OAuth installation, sender change,
campaign activation, or deployment was performed.

Production is bound to **Lash Her By Nataliea**, location
`vd09FLBpPLXuHb5Tnhn4`. Development and preview reject that location. Use a separate
test location **and database**; do not reuse entity mappings across locations.

The connected developer MCP is read-only. Its operation discovery filters out
workflow/configuration writes and workflow inspection. It cannot create the
runtime marketplace OAuth application or apply the setup manifest. The user supplied
authenticated browser access for native setup. Email uses a shared domain and no
phone number is configured. The separate developer portal requires its own sign-in.
Sender authentication, OAuth installation, the aggregate sending gate, and native
workflow execution remain release blockers; local tests cannot substitute for them.

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

Contact identity uses normalized email and a separate phone lookup. Conflicts are
held for review instead of merged. Only missing profile fields are filled; unrelated
tags are preserved through additive tag operations. SMS is evaluated for the exact
normalized destination. Native workflows must compare the eligibility destination
field with the contact's current email/phone before sending, including after staff edits.

Only approved website fields are synchronized. Notes include the general inquiry
message, capped at 4,000 characters, and program/source context. Booking intake
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
website-owned notes and fields are removed, journeys stopped, and contact-wide
deletion is exposed for administrator review because a CRM contact may contain
staff-owned records. The reviewed deletion action deletes the provider contact and
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
