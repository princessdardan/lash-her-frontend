# Resend historical contact and marketing scope

This is a read-only domain observer for the existing locked host worker. It qualifies source and owned fixtures only. It makes no provider mutations and does not by itself authorize retirement, migration, traffic, or activation. The shared integration owner composes it with credential denial, historical executions, exact original configuration, complete email outcomes, and the remaining provider families.

## Historical source findings

The [audit](baselines/2026-11-05-resend-marketing-scope/historical-source-audit.json) binds four retained Git revisions, including C07 `b99d4f346696f897fa6a6729dfcc52d6503fe8d6`, to exact blob IDs and SHA256 values. All 13 selected source paths are byte-identical across those revisions. This observation applies to those paths, not to the complete source trees or original deployment configuration.

| Actual path | Provider requests and durable evidence |
| --- | --- |
| `src/lib/marketing-contact/marketing-contact-sync-worker.ts` → `src/lib/resend-platform.ts` | Claims a durable sync job before contact update/create, segment list/add, topic opt-in, and an opt-in event. Unsubscribe jobs update global suppression and treat provider not-found as success. Current HighLevel ownership can skip opt-in sync; current flags cannot establish historical absence. |
| `src/lib/marketing-contact/marketing-contact-store.ts` | Stores contact, submission, consent, and sync intent in PostgreSQL. Provider unsubscribe records source `resend` and a contact ID, suppresses the existing contact, cancels pending opt-in jobs, and redacts unsent welcome offers. Consent and suppression records remain retained. |
| `src/app/api/webhooks/resend/handler.ts` | Verifies the signed `contact.updated` event before persisting an unsubscribe. The observer does not accept arbitrary callback input or invoke the callback. |
| `src/app/admin/(protected)/marketing/campaigns/actions.ts` → `src/lib/marketing-campaign/send-campaign.ts` | Claims `marketing_campaigns` before broadcast create/send. The provider name is `campaign:<UUID>`. The provider ID is recorded after create, leaving a lost create acknowledgement uncertain. Scheduled, queued, failed, unmatched, and unrecorded broadcasts remain unknown. |
| `src/lib/env/staging-email-policy.mjs` + `application-environment.mjs` | Both broadcast create and send call the business-environment guard before the SDK mutation. The guard rejects resolved staging. Exclusion requires the exact historical guard, resolver, locked SDK, and immutable original runtime configuration. It is not source absence and cannot be inferred from a current disabled flag. |
| `scripts/seed-resend-templates.ts`, `scripts/update-contact-popup-resend-template.ts` → `src/lib/resend-template-seeding.ts` | Reachable manual template create/update/publish operations. These belong to the shared template capability requirement, not to contact proof. |

The facade also exports segment/topic/automation/broadcast/template management wrappers. An export alone does not prove an application or manual entrypoint. The source manifest owner audits actual callers and retains uncovered requirements for those families separately.

Every retained lock selects Resend `6.12.3` with the same integrity. The official npm archive was checked against that integrity, and its module bytes match the installed module. `Events.send` exists and sends `POST /events/send`; missing-method exclusion does not apply. Contact sync catches event errors and does not persist an event execution outcome, so a succeeded job cannot settle the event or any automation it may trigger. The observer performs no invented event/automation history query. Resend documents [event sending](https://resend.com/docs/api-reference/events/send-event) and [automation run listing](https://resend.com/docs/api-reference/automations/list-automation-runs); obtaining complete execution evidence for an actual configured path remains a separate requirement.

## Source-bound interface

`ops/platform/host/frontend_resend_marketing_scope.py` exports:

- `database_queries(reviewed)`: six literal, schema-qualified `SELECT` triples, each bounded to 4097 rows. The normalizer refuses more than 4096. Execute literals as supplied in a read-only repeatable-read transaction; do not append a second `LIMIT`.
- `normalize_snapshot(actualRows)` and `snapshot_sha256(actualRows)`: exact safe columns, duplicate and state checks, stable ID order, canonical JSON SHA256.
- `read_only_request(method, path, body, reviewed)`: permits fixed GET paths only, with UUID cursors and page size 100.
- `observe_scoped_effects(privateLockedClient, reviewed, actualRows, verifiedSourceRequirements, before=None)`: observes provider state twice, matches privately, and returns only safe IDs, states, counts, source/snapshot digests, covered/missing requirement IDs, and bounded transition receipts.

The outer reviewed object contains the existing Resend retirement binding and `resendMarketing`:

```text
{
  environment: "staging",
  databaseSnapshotSha256,
  sourceInventorySha256,
  requirementsSha256,
  configurationSha256,
  segmentIdsBySource: { booking: [...UUIDs], course_signup: [...],
    contact_popup: [...], general_inquiry: [...], sanity_backfill: [...], training_contact: [...] },
  topicIdsBySource: { ...the same six source keys... }
}
```

Those maps contain IDs derived from the exact original configuration, including common marketing IDs merged with each source's IDs. They are not an approval or an arbitrary replacement environment. The shared source owner verifies that derivation. The observer requires matching source inventory and requirement digests and consumes verified per-revision capability closures. It does not generate or authenticate those closures itself.

When all five families have exact verified capability closures and all six actual SQL arrays are empty, the observer returns `source-inapplicable-and-effects-reconciled` without constructing a provider client or obtaining an unrelated replacement credential. It marks provider pagination as unobserved, not complete. A source disposition alone or a partial closure cannot select this path. Any retained SQL row contradicts an all-family closure: the observer requires actual provider reads and retains an explicit unknown; campaign rows also force broadcast reads.

The selected families are `resend.contacts`, `resend.segments`, `resend.topics`, `resend.broadcasts`, and `resend.events`. Requirement IDs come from the source-generated `configurationConditions`, `sqlIntentRequirements`, and `untrackedPotentialRequests` arrays. Capability closures contain their family IDs, requirement IDs, and nonsecret 64-hex evidence IDs. All reachable untracked requirements remain explicitly missing until a verified source/configuration closure covers them. Empty provider lists and successful sync rows do not erase those requirements.

## Observation and recovery rules

SQL reads all contact, submission, consent, sync-job, campaign, and Resend welcome-offer intents. It does not filter by current opt-in or marketing ownership. It projects normalized email hashes, provider/record IDs, states, attempt counts and budgets, timestamps, redaction booleans, and lease booleans. It does not select plaintext addresses, names, consent text, subjects, bodies, encrypted values, raw payloads, idempotency keys, or credentials. Email hashes remain private matching data and are omitted from public effect receipts.

The provider side uses complete [contact pagination](https://resend.com/docs/api-reference/contacts/list-contacts), [contact detail](https://resend.com/docs/api-reference/contacts/get-contact), [segment membership](https://resend.com/docs/api-reference/contacts/list-contact-segments), and [topic subscription pagination](https://resend.com/docs/api-reference/contacts/get-contact-topics). Unsubscribed state must agree with SQL. Subscribed contacts must retain required historical source membership and topic opt-ins. A provider contact without a durable matching intent remains unknown; the observer never deletes it.

Where the verified source/configuration does not close broadcast capability, it reads complete [broadcast pagination](https://resend.com/docs/api-reference/broadcasts/list-broadcasts) and [broadcast detail](https://resend.com/docs/api-reference/broadcasts/get-broadcast). A terminal dispatch must match the durable campaign ID, recorded provider ID, segment, name, and terminal state. A terminal dispatch is not per-recipient delivery proof; the shared complete-email observation remains necessary. The [provider pagination contract](https://resend.com/docs/api-reference/pagination) requires an explicit limit with `after`; duplicates, repeated cursors, malformed pages, changes between reads, and bounds exceeded fail closed.

Welcome-offer rows require actual matching terminal [email outcomes](https://resend.com/docs/api-reference/emails/retrieve-email). Dead-letter/redacted status does not settle a possible lost send acknowledgement. A never-claimed offer may settle only through the original snapshot's queued/attempt-zero/no-lease/no-provider-ID intent and the source-bounded unsubscribe callback transition. An attempted send remains unknown after redaction.

The original planned snapshot is immutable. A later observation may advance only these bounded source transitions against that same snapshot:

1. An existing queued, processing, or retryable sync job becomes succeeded with unchanged intent, monotonic attempts within the unchanged original `max_attempts` budget, a positive completion timestamp, and a cleared lease.
2. A provider-backed unsubscribe appends its consent event for an existing matching contact, changes only its suppression fields, cancels matching pending opt-in jobs, and may redact its unsent offer. Provider contact ID and observed suppression must agree.

The reducer rejects removed consent history, new recipients/intents, changed campaign state, altered job identity, or other business changes. Normal callbacks do not require a replacement plan or human reapproval. Recovery never invokes a send, retries work, edits consent, or deletes unrelated marketing.

Any lease, unresolved intent, pending/scheduled effect, unmatched result, absent acknowledgement, untracked request requirement, unavailable API, or unsupported state prevents completion. The observer adds no retention duration, delivery deadline, refund rule, or suppression policy.

## Qualification

The [portable baseline](baselines/2026-11-05-resend-marketing-scope/README.md) records the source revisions, official SDK verification, retained failed attempts, and passing owned fixtures. No actual Resend API, original runtime configuration, live credential, or customer record was accessed.
