# Frontend operational provider applicability and observations

This source audit scopes the frontend SQL release. It is not live provider or
historical deployment certification. The accepted C07 and private handoff remain
accepted inputs; they must be read back at execution. Provider feature flags and
the October provisioning snapshot cannot establish current historical bindings.

| Provider surface | Source evidence and frontend SQL effect | Required actual evidence |
| --- | --- | --- |
| Mux in frontend Studio | `src/sanity/sanity.config.ts` registers public Mux input; `short-course.ts` validates a ready public asset. The only frontend Mux notification mapping is editorial cache revalidation in `src/app/api/revalidate/handler.ts`. There is no Mux operational table or frontend Mux service client. | Preserve public assets and signers. Bind the historical frontend sources/configuration to this editorial scope. New Course media uses the separate Course database and its own credential/webhook authority; it does not become a frontend SQL writer merely because a frontend references it. |
| Sanity API clients | `src/sanity/lib/client.ts` is the public unauthenticated reader. `write-client.ts` declares `SANITY_WRITE_TOKEN`, but has no source consumers. A configured token alone does not create an operational writer. | Inventory historical source/configuration before excluding an older token scope. Do not force unrelated editorial API-token retirement for current frontend SQL. |
| Sanity inventory hook | `src/app/api/webhooks/sanity/inventory-sync/handler.ts` accepts signed product notifications and synchronously updates `product_stock`. Revalidation is separate editorial/cache work. | Exact dedicated staging hook list and destination paths; disable/read back selected hooks; complete accepted message and attempt inventories, including queued/running retries. The new fixed executor below supplies those supported observations. |
| Google Identity | Auth.js callback persistence is a frontend database continuation. Calendar and Identity use distinct staging clients in project `185770842371`. | Actual historical client/redirect bindings, callback ingress retirement/admission, historical SQL role retirement and actual pending continuation handling. Do not revoke Calendar grants as a substitute for Identity client controls. |
| Google Calendar | `google-calendar.ts` refreshes grants and creates/updates external events; connection/grant/event metadata also persists in the frontend database. `admin-calendar-oauth-callback.ts` is a separate continuation. | Actual encrypted SQL connection metadata, event IDs/etags and OAuth continuations, plus the legacy Redis grant. The dedicated staging Vercel Production target uses the `production` Redis token namespace in `google-refresh-token-store.ts`, with fallback to the legacy unscoped key. Empty SQL connections do not establish grant absence. Preserve independent eligible booking recovery until its deliberate drain stage ends. |
| HighLevel | OAuth refresh credentials reside in `highlevel_connections`; callbacks write receipts/contacts; `highlevel_outbox` and `highlevel_effects` contain accepted work. | Historical credential and callback bindings, encrypted connection presence, effects/intents/provider IDs, actual supported revocation/denial and accepted workflow outcomes. Disabled sync/marketing flags do not prove absence. The production location `vd09FLBpPLXuHb5Tnhn4` is not a disposable staging scope. |
| Chit Chats | The worker reads `product_shipment_jobs`, performs external shipment/postage operations, and persists `product_shipments`. No incoming shipping webhook is registered by source. | Historical sandbox account/token bindings, actual stored shipments/jobs, provider shipment/order references and unknown outcomes. Token retirement cannot undo accepted postage. Do not purchase, refund, delete or replay shipments merely to demonstrate a fence. |
| Resend | Transactional sends, customer email outbox, marketing contact synchronization, and `contact.updated` callback persistence are separate effects. Historical direct sends need not have a stored email acknowledgement. | Dedicated staging account/domain, complete key/hook lists, protected replacement runtime, acknowledged old-key deletion/absence/HTTP 401, disabled callbacks, complete account sent-email pagination and actual stored intent reconciliation. A selected known-ID list is insufficient coverage. |
| Square | Historical service/product/training payment and refund continuations persist frontend state; the single current callback is `/api/webhooks/square`. | Dedicated sandbox application/location/subscription, protected replacement runtime, exact callback disable/readback and old PAT HTTP 401 `UNAUTHORIZED`; compare actual stored immutable money/reference/order/application/outcomes. Selected known financial rows do not prove account-wide effect coverage. Retain production/shared legacy callback scopes separately. |
| Direct callers | Manual scripts, external schedules and other retained deployments can use old SQL logins independently of the current frontend flags. | Bind each caller to its exact historical login OID and provider scopes; observe `NOLOGIN` and no remaining selected sessions under the physical database lock. All applicable provider effects still require reconciliation. |

## Fixed database inventory

`observeFrontendOperationalProviderInventory()` runs 13 fixed projections in a
repeatable-read read-only transaction under the caller's live lock verifier. It
observes Calendar connection/event references, CRM connections/continuations/
outbox/effects, shipping shipments/jobs, the customer email outbox, Square booking
attempts and refunds. It retains only table presence, row counts/digests and
credential-record counts. It never reads plaintext credentials, decrypts a
grant, selects PII payload columns, changes a job, or calls a provider.

The coordinator retains separate before-fence and after-drain observations.
Those snapshots do not by themselves assert historical deployment coverage,
provider retirement or provider reconciliation. Absent historical tables retain
`rowCount: null`; an absent relation is not a fabricated empty table. Overflow,
SQL failure or lost lock verification refuses the entire observation. The fixed
Square row observer remains responsible for its selected immutable financial
comparisons.

## Supported Sanity hook component

`frontend_sanity_fencing.py` is invoked through the existing isolated, source-pinned
Python worker. It allows only the dedicated `7o23yrvk` /
`staging-2026-05-10` scope, exact reviewed hook IDs and staging callback paths.
The source-owned allowlist permits GET hook/list/message/attempt requests and
only `PATCH {"isDisabledByUser":true}` on a reviewed hook. Every request receives
the existing parent liveness checkpoint.

`suspendFrontendSanityHooks()` privately verifies both supplied credentials can
read the same exact scope before changing hooks, retains each disabled readback,
and retains an uncertain exact hook when acknowledgement/readback fails. It does
not delete content, enable a hook, replay a delivery or invent a token-management
endpoint. The existing operator can separately retire an applicable API token in
Sanity's supported controls; `observeFrontendSanityScope()` reports actual old
HTTP 401 denial only. HTTP 403, scope mismatch and missing metadata refuse.

Accepted messages and attempts are fully paginated with explicit bounds and
duplicate detection. Two independent complete reads must match. The observer
retains message IDs/status/HTTP result, active attempt counts and unresolved
counts, while omitting signatures, callback queries, request/result bodies and
content. Per Sanity's documented delivery policy, 2xx and undeliverable 4xx
(excluding 429) stop that delivery; explicit `canceled` is terminal. Queued,
running, 429, 5xx and unknown outcomes remain unresolved. Disabling a hook does
not empty its existing queue.

Reviewed nonsecret binding shape:

```json
{
  "sanityRetirement": {
    "projectId": "7o23yrvk",
    "dataset": "staging-2026-05-10",
    "hooks": [{"hookId": "5a1KWQjkVBYLeAU3", "path": "/api/revalidate"}]
  }
}
```

The private runtime supplies `sanityReplacementToken` and `sanityRetiredToken`
through the established runtime-context supplier. Neither value enters the
reviewed artifact or receipts. Listing discovers any unreviewed hook and refuses
before mutation, so the example does not declare that no inventory hook exists.

## Complete Resend accepted-email readback

`observeFrontendResendEffects()` uses the documented `GET /emails?limit=100` and
`after` pagination in the already isolated staging account. It includes emails
whose original send acknowledgement was lost, rather than querying only supplied
IDs. Two complete sanitized ID/state inventories must match. Every reviewed known
ID must appear; repeated cursors, duplicate IDs and bounds refuse. Recipient,
subject and message bodies are discarded before output.

Delivered/opened/clicked, bounced/complained, failed, canceled and suppressed
outcomes are terminal for this send observation. `sent`, queued, scheduled,
delivery-delayed and unrecognized states remain unresolved. No email is sent,
canceled or rescheduled by this component. Old-key retirement and disabled
callbacks remain separate requirements; a complete sent-email list does not
prove contact/marketing reconciliation.

## Validation and remaining execution boundary

Executed November 5, 2026: 49 owned HTTPS provider tests, 20 Node adapter/
coordinator tests, and a fresh owned TLS PostgreSQL 16 run through all 83 source
migrations. The database run exercised every projection, actual encrypted
connection presence, private-data redaction, absent historical relations,
overflow refusal and lost-lock rollback. No live provider, staging database or
deployment was changed. These results do not certify PostgreSQL 18, historical
live bindings, actual Google/CRM/shipping retirement or G2.

The whole-fence export remains closed because actual full historical binding
coverage, provider-specific outstanding-effect reconciliation, Google/legacy
Redis grant controls and direct-caller applicability are not yet joined into a
source-qualified complete certificate. This is a concrete integration boundary:
the new observations cannot be converted into zero counts or SQL authority by a
caller boolean, configured feature flag, screenshot or operator checkbox.

Primary references: [Sanity hook HTTP API](https://www.sanity.io/docs/http-reference/webhooks),
[Sanity delivery policy](https://www.sanity.io/docs/content-lake/webhooks),
[Resend sent-email listing](https://resend.com/docs/api-reference/emails/list-emails),
[Google web-server OAuth and revocation](https://developers.google.com/identity/protocols/oauth2/web-server),
[Chit Chats API](https://chitchats.com/docs/api/v1).
