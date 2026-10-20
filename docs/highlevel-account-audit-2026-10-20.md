# HighLevel account configuration — 2026-10-20

Location: **Lash Her By Nataliea**, `vd09FLBpPLXuHb5Tnhn4`.

Authenticated browser access was provided by the user. The developer MCP remains read-only.

## Applied configuration

- Created Contact custom-field folder **LH Website**.
- Created all 20 fields from `highlevel-setup-manifest.json`; verified names, contact keys, and saved IDs in the UI. Actual production IDs are recorded in that manifest.
- Created all 10 namespaced website/source tags. These tags carry no permission and have no new automation triggers.
- Created four source-filtered smart lists: General inquiries, Training inquiries, Course interest, and Newsletter signups. Each uses `LH Website Source Is <source>`; actual list IDs are in the manifest. All currently contain zero contacts.
- Created **LH Website — Drafts** workflow folder and all six native drafts: Welcome and offer, General inquiry, Training inquiry, Course interest, Post-purchase, and Reactivation. Actual IDs are in the manifest. All remain draft with zero enrolled contacts and no native entry triggers. No draft is approved for activation.
- No contact import, marketing enrollment, publication, message delivery, number purchase, production deployment, or production database migration.

## Existing automation

- **Free course** (`525cb19a-ea2b-4bb3-ae39-f69392d35f60`): published; 2 total/0 active enrolled. Instagram comment trigger filters phrase COURSE; TikTok comments has no filters. Social-comment response actions; no contact-created trigger observed.
- **LDA** (`db1ea558-6f18-4dc4-a8c1-9d3fba99943c`): published; 2 total/0 active enrolled. LDA Form submission filter plus Instagram DM/comment keywords LDA/lda; routes to Instagram replies/DM and follow-up tagging. No contact-created/tag-added entry trigger observed.
- **Training Form** (`87443c4b-821f-4c0d-a5e9-a0c376d8353a`): published; 8 total/0 active enrolled. **Form Submitted has no filters**. Instagram comment/DM triggers match Training/TRAINING/Course/COURSE. Routes to Instagram form delivery or ensure-to-call tagging. The broad native-form trigger should be narrowed by its owner before additional native forms are introduced. The website adapter does not submit native HighLevel forms.
- **Lead Scheduling and Pipeline** (`8dbf51ec-a7d9-4a88-80d4-cd46e60e01dc`): draft; 0 enrolled.
- Existing **Marketing Workflows** folder contains six draft templates: New Lead Nurture (Fast 5) - Claim Offer; Appointment Confirmation + Reminders; Appt No Show; New Sale - Send Review Request; Long-Term Nurture; Stale Leads. All show 0 enrolled. They remain unchanged.
- Global Workflow Settings exposes builder access, error notification, auto-save, scheduled pause, and Workflow AI. No aggregate contact-level email/SMS frequency control was visible there.

## Sender audit

- Email Services uses shared domain `mail.msgsndrlj.com`; no dedicated domain configured. Dashboard shows 500 emails/day and 0 sent today. This account-wide daily limit does not enforce the per-contact weekly policy.
- Reply & Forward Settings has no forwarding/BCC/reply override addresses configured; Forward to assigned user is off. A Reply Address override warns that replies bypass Conversations, so none was added.
- Phone System → Phone Numbers shows **No Data**. No usable sending number is configured.
- Requested the marketing From/monitored mailbox and the desired SMS number approach from the user. No sender purchase or DNS change was made.

## Identity and account settings

- Contact Deduplication Preferences: **Allow Duplicate Contact off**, first search preference **Email**, second preference **Phone**. The website adapter also independently checks email/phone conflicts before an upsert.
- Native email unsubscribe footer is enabled. Email verification on the first send is not enabled.
- Account timezone is **America/Toronto**. Draft workflow sending windows use account time, Monday–Friday, 10:00–18:00; DST follows that timezone.
- The Marketplace developer portal remains on its separate sign-in page. Website OAuth credentials have not been created or read.

## Native workflow review

Review the saved drafts in the [website workflow folder](https://app.gohighlevel.com/v2/location/vd09FLBpPLXuHb5Tnhn4/automation/workflows?folder=f9904f77-47a0-4a4b-808d-03e4f1fbd48e&tab=list&listTab=all).

| Draft             | Native workflow ID                     | Relative schedule                                             |
| ----------------- | -------------------------------------- | ------------------------------------------------------------- |
| Welcome and offer | `6406b243-d442-4657-914f-f5cf291ad01a` | Email day 0 or offer variant; email day 4; optional SMS day 7 |
| General inquiry   | `27d4c567-9384-4ee0-8a3d-11d8cc69bddb` | Email day 2; optional SMS day 4; email day 6                  |
| Training inquiry  | `2ada3b48-8b16-49a3-9330-045e7972d811` | Email day 2; optional SMS day 4; email day 6                  |
| Course interest   | `7fa8d0fa-f7eb-4e6a-a23d-3117cab504fa` | Email days 2 and 6; optional SMS day 9                        |
| Post-purchase     | `6f0af866-99a4-493c-b684-ed1f366b39d1` | Email days 2 and 6; optional SMS day 9                        |
| Reactivation      | `05c1ac83-6469-43ce-b431-e2dee248a51b` | Email days 0 and 4; optional SMS day 7                        |

The weekday window may defer a send past its nominal day. No message has been sent.

All six drafts have actual conditional branches, email/SMS actions, the specified
wait steps, and independent channel paths. Their email gates check
`email_eligible=yes`, email DND exclusion, and the recorded email destination against
the native `{{contact.email}}` variable. Their SMS gates check `sms_eligible=yes`, SMS
DND exclusion, and the recorded phone against `{{contact.phone_raw}}`. The latter's
normalization and the condition runtime still require test-contact execution.

The drafts exclude historical imports and empty journey keys. Re-entry and multiple
opportunities are off; stop on response is on. Sender fields remain empty. Native
stop-on-response alone does not establish staff-takeover or cross-workflow stop
behavior. No native contact-wide rolling-seven-day sending gate has been verified.
These are activation blockers even when the individual draft actions are present.

The native builder required corrections: an unintended inbound-webhook trigger was
removed, blank reactivation conditions were populated, and destination comparisons
were added manually with the native variable picker. Persisted definitions were
reopened and inspected; all 18 channel gates retained their explicit consent, DND,
and destination checks. The wait action values and day units were also inspected.
These UI checks establish saved configuration, not successful
execution, delivered messages, approved copy, or the aggregate cadence. Native
unsubscribe footer rendering, all branch joins, changed destination normalization,
and STOP during waits remain in the live verification matrix.

## Release status

CRM synchronization and marketing remain disabled. Separate production OAuth installation, isolated test-location verification, dedicated email authentication, SMS sender setup, shared sending gate, reviewed workflow definitions, and live designated-contact tests remain required.
