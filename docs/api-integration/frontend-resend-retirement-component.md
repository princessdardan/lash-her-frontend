# Isolated staging Resend credential retirement component

This component performs real supported provider operations inside the existing source-pinned locked worker. It is source/owned-fixture qualification only. No actual credential was retrieved, created, replaced or retired; no mail, contact write, webhook enablement or live provider request occurred. Whole P2-00 fencing, complete historical effect coverage and live release acceptance remain open.

## Reviewed binding and stages

The normalized provider binding artifact may include `resendRetirement` with exact `domainId`, `domainName: "mail.staging.lashher.com"`, distinct `retiredKeyId`/`replacementKeyId`, complete sorted `expectedKeyIds`, exact `webhookIds`, and `knownEmailIds`. All IDs are provider UUIDs and are bound by the existing artifact/source/action hash. At least one reviewed external provider surface must identify Resend. Credential-binding hashes identify provenance records, never credential values.

Prepare the replacement through the supported existing operator/provider credential path before destructive retirement. The private runtime supplier supplies `resendReplacementToken` and, for retirement/read-only observation, `resendRetiredToken`. The adapter neither fetches secret values nor prints or hashes them. A reviewed admission-bootstrap build installs only the replacement as sensitive `RESEND_API_KEY`, plus the exact nonsecret probe domain settings. Its ordinary migration/source/admission checks remain required.

`retireFrontendResendCredential` requires the parent's closed, drained ledger observation and actual lock verifier. It composes these operations:

1. Verify the actual completed admission-bootstrap source/project/build/protected workload/promotion. Perform the protected deployed runtime `resend-binding` probe before destructive provider work.
2. Read the exact verified isolated staging domain using both credentials. Enumerate every key and webhook page twice and refuse any unreviewed ID/drift. Read callback bindings privately and accept only the canonical staging contact-updated webhook scope; credential-bearing URLs are never retained.
3. Disable/read back each exact selected staging webhook. Keep its events, endpoint and signing state unchanged. An unavailable or unverified disable stops before key retirement.
4. Recheck the complete key set, durably record intent, then issue one exact `DELETE /api-keys/OLD_ID`. Retain its exact ID/deleted acknowledgement independently. Observe actual old-key absence, require old-token HTTP401 denial and preserved replacement access. HTTP403, outage or quiet metadata is insufficient proof.
5. Repeat the protected deployed runtime read using that deployment's own `RESEND_API_KEY`. This catches a frontend still using the retired credential. Retain a separate runtime-binding receipt; failure after key deletion preserves the original deletion and leaves the runtime gate incomplete, with no rollback, replay or credential recreation.

The runtime probe uses the same expiring release bearer/challenge and staging-only `x-lash-release-mode: resend-binding`. It first proves the existing read-only admission/bootstrap/gateway checks and then performs only a fixed official `GET https://api.resend.com/domains/UUID`. It returns allowlisted domain ID/name/verified status, hosted source and challenge, with `Cache-Control: no-store`; no key value, prefix, hash, incoming credential or raw provider response is returned. TLS verification, fixed origin, response size/type and timeout are enforced. Redirects and provider errors fail closed.

Use `recoveryAfterCompatibleBuild: false` for a release that performs this closed-ledger retirement stage. Eligible recovery may resume only through an explicit stage in the same reviewed release after its provider bindings are verified. The component does not automatically reopen it after success or failure.

## Outstanding effects and deliberate recovery

The result remains `STAGING_RESEND_CREDENTIAL_RETIRED_EFFECTS_UNRESOLVED`. `activeExecutions` and `uncertainEffects` remain `null`; `historicalWritersFenced` remains false. Known email IDs are retrieved through their actual provider GET and return only ID/`last_event`; recipient/content data is discarded. Queued, delayed, scheduled and unrecorded operations still need actual domain reconciliation. A key list, credential denial or known subset cannot prove exhaustive old-operation coverage or permit SQL.

A lost DELETE acknowledgement records the exact mutation as uncertain and stops. Original intent/outcomes are exclusive and immutable; observing the ID absent later does not rewrite the original acknowledgement. `observeFrontendResendCredential` is read-only and can run under a distinct recovery action using the original binding. The aggregate external observer retains actual Resend scope observations for the selected surface while continuing to label its unreconciled fence state explicitly.

The provider client allows only bounded metadata/domain/webhook/email GETs, exact key DELETE and webhook `status: disabled` PATCH. It has no send, create-key, enable-hook, replay, contact-write or alternate-provider-origin operation. All credentials stay in private child stdin/runtime memory.

Owned tests cover paginated identities, staging/domain drift, actual webhook PATCH/readback and key DELETE, lost acknowledgement/no replay, unrevoked old token, HTTP403 refusal, unchanged original recovery receipts, queued effect observation, and a deployed-runtime model retaining the old credential. Source tests exercise the actual Node HTTPS domain reader against an owned TLS server, including invalid TLS, redirect, unauthorized, content-type/size and scope refusal. These tests establish only their controlled component scope.

Primary provider references: [key listing/pagination](https://resend.com/docs/api-reference/api-keys/list-api-keys), [key deletion](https://resend.com/docs/api-reference/api-keys/delete-api-key), [webhook disable](https://resend.com/docs/api-reference/webhooks/update-webhook), [domain retrieval](https://resend.com/docs/api-reference/domains/get-domain), [known email retrieval](https://resend.com/docs/api-reference/emails/retrieve-email).
