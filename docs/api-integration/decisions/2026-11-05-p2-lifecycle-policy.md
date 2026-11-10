# Approved P2 lifecycle policy

Status: APPROVED by Dardan in this goal on November 5, 2026 (America/Toronto). Applies to P2-11/P2-12. The approval permits implementation of these policies; no live deletion or deployment is inferred.

## Existing fixed requirements

Customer UUIDs, separate administrator identities, immediate frontend session revocation and cessation of token issuance on suspension/deletion, ordered commands to both receivers, exact replay and terminal deletion tombstones follow published v1. User tokens last at most 300 seconds with 30 seconds of skew; existing playback tokens last 600 seconds. Deletion cannot be restored, and delayed enrollment events cannot recreate a deleted identity. Private export bytes and bearer download links do not enter lifecycle commands/receipts.

## Approved technical and product choices

| Topic | Proposed behavior | Approval/evidence needed |
| --- | --- | --- |
| Export access and expiry | Authenticated same-origin retrieval, bound to the requesting customer or separately authorized administrator, with no public/bearer link. Export artifacts expire 24 hours after becoming ready and are then deleted. Fresh authentication is required to request a new export. | 24-hour expiry approved; isolation and expiry tests required. |
| Customer suspension/deletion | Revoke all frontend sessions and prohibit new customer-token issuance in the same transaction that records the state and durable commands. Check active state on each protected frontend operation. | Existing requirement; test transactionality and cross-device revocation. |
| Outstanding tokens and requests | Receiver account state denies new protected operations after its command commits. During delayed delivery, outstanding user tokens may remain valid for at most 330 seconds after last issuance; already issued playback may remain usable until its 600-second expiry. Do not claim cancellation of an external effect already admitted. | Residual windows acknowledged; measured denial and race tests required. |
| Receiver outage and restoration | Keep ordered delivery durable and retry only retryable outcomes. Frontend stays denied while suspended/deleted. Do not reopen a restored account's frontend access until both receivers acknowledge the ordered restore and all predecessor commands. Terminal deletion never reopens. | Restore availability tradeoff approved; outage/sequence-gap tests required. |
| Newly introduced account PII | Remove eligible customer profile/provider-link/session/token data as part of deletion; retain the immutable customer UUID only where required for minimal tombstone, ordered delivery, idempotency and immutable audit references. | Eligible profile/provider-link/session/token removal approved; no new statutory period invented. |
| Learning records | Include progress, attempts and grants in authenticated export. On account deletion, delete progress and deidentify retained attempts. Preserve required minimal tombstones and immutable grant/audit references; retain no unnecessary profile identifiers in attempt payloads. | Explicitly approved; test actual persisted deletion/redaction and immutable references. |
| Financial and operational records | Do not change existing financial, appointment, training, shipping or provider-event retention rules during P2. Apply customer deletion through a reviewed field-level redaction/retention map rather than cascading deletion of business/audit rows. | Preservation of existing financial/operational retention approved; code values below remain implementation facts, not a new statutory interpretation. |
| Marketing | Customer account creation never subscribes. Preserve separate consent and suppression history; account deletion does not fabricate a subscription or erase required suppression evidence. | Existing separate marketing consent/suppression retention approved. |

## Existing implementation values to preserve pending review

`src/lib/private-db/retention.ts` currently defines checkout-order redaction at 365 days or 180 days after terminal state, soft deletion at 2555 days and purge 30 days after soft deletion; payment-event payload scrubbing at 90 days and deletion at 730 days; appointment redaction at 395 days; training-enrollment redaction at 395 days and deletion at 2555 days; inactive marketing-profile redaction at 730 days, unsubscribed-contact deletion at 2555 days and consent-event deletion at 2555 days. These values do not establish newly approved legal requirements. Existing domain guards and the complete field-specific implementation remain authoritative until expressly amended.

## Approval record

Dardan selected: `Approve defaults; delete progress and deidentify retained attempts`. The approval includes the 24-hour authenticated export policy, outstanding user/playback windows, restoration-after-both-receivers behavior, minimal tombstones/immutable grant-audit references and preservation of existing financial and separate marketing consent/suppression retention. No new legal retention duration, expansion into future Community domains or live release is authorized. Any newly discovered record class or legal hold outside this matrix requires a specific decision before its destructive handling. P2-11/P2-12 still require implementation and certification evidence.
