# Historical Chit Chats quote, cache and draft effects

`ops/platform/host/frontend_chitchats_transient_effects.py` is a source-only, read-only component. Its observations do not authorize traffic, polling, SQL admission, credential retirement or financial mutations. The shared provider worker supplies its existing locked staging client and source-verifies each historical revision independently.

## Audited historical source

Exact C07 revision: `b99d4f346696f897fa6a6729dfcc52d6503fe8d6`. Paths/lines below are from that immutable revision, not current shipping preparation implementation.

| Source reference | Actual effect / durable evidence | Historical gap |
| --- | --- | --- |
| `src/app/api/cron/shipping-rate-cache-refresh/route.ts:14` | Bearer worker/cron secret; route gates `CHITCHATS_SHIPPING_ENABLED` and `FLAT_RATE_SHIPPING_ENABLED`; calls refresher at24 | Current flags cannot prove original configuration. Direct exported refresher has no flag gate. |
| `src/lib/shipping/flat-rate-refresh.ts:75,133,165,193` | 9 zones ×6 buckets; POST draft with `flat-rate-probe-${zone}-${bucket}`; cache upsert; best-effort DELETE | No durable per-request intent, provider ID, lease or completion receipt. Cache rate/time is not a request completion receipt. POST may be accepted before ID is returned; deletion error is swallowed. |
| `src/lib/shipping/flat-rate-zones.ts` | Source-owned representative dimensions/destinations and54 reference patterns | Reused probe references do not identify a unique execution. Body/reference matching identifies a shape, not an exhaustive request ledger. |
| `src/app/api/shipping/quotes/route.ts:325,356` and `src/lib/shipping/shipment-store.ts:68,197` | Flat-rate path persists local quote only; live path transactionally persists shipment plus create job | Flat-rate local quote must be distinguished from refresher probe. Neither an empty rate cache nor unattached quote absence proves no external requests. |
| `src/lib/shipping/operation-worker.ts:247` | Live quote draft POST; shipment public reference plus create job, payload hash/lease/outcome | POST acceptance precedes provider-ID persistence. Missing/mismatched provider ID cannot be adopted from a reference alone. |
| `src/lib/shipping/operation-worker.ts:381,479` | Quote/purchase-time refresh PATCH, durable job payload and outcome | Provider body must match the actual intent; processing, unknown outcome or incomplete receipt remains unresolved. |
| `src/lib/shipping/operation-worker.ts:703` | Fulfillment-time flat-rate draft POST inside purchase operation | Acceptance-to-persistence gap; durable job alone does not prove completed provider acceptance. |
| `src/lib/shipping/operation-worker.ts:886` | Unpaid draft DELETE; persisted `provider_deleted`, `provider_deleted_reconciled` or `provider_not_found` completion | Current provider absence alone cannot prove deletion. Complete inventory plus settled positive deletion receipt is required. |
| `src/lib/shipping/chitchats-client.ts:85,109,140` | Actual POST/PATCH/DELETE transport and payload transformation | No invented provider history, global cancellation or key-revocation API. |

The frozen audit inventory includes exact Git blob OIDs and SHA256s. The recognized C07 probe shape additionally binds the refresher, zones and payload-client blobs. Unknown source shapes remain unmapped. Only actual Git/source verification can supply `verifiedSourceRequirements`; the observer does not turn caller flags into source proof.

## API and private bridge

- `database_queries(reviewed)` returns four literal SELECTs, each with an overflow sentinel `LIMIT4097`. The component rejects more than4096 rows. Read **all** in one repeatable-read, read-only transaction; read again after provider observation and compare `normalize_snapshot` results.
- `normalize_snapshot(actualRows)` checks exact columns, IDs and relationships. It hashes destinations, customs descriptions/manufacturer data, quote fingerprints, rate/raw provider payloads and private job payloads. It emits no names, addresses, email, signed label URLs or payload strings. Raw rows may travel only in private worker memory/stdin; never log or persist them. Exceptions are sanitized.
- `observe_scoped_effects(privateLockedClient, reviewed, actualRows, verifiedSourceRequirements)` returns sanitized per-effect/operation receipts and bounded known active/uncertain counts. An unresolved source request-completeness gap makes aggregate `activeExecutions` and `uncertainEffects` **null**, even if the known counts are zero.
- `read_only_request(method,path,body,reviewed)` is the shared fixed-staging transport classifier. It admits only GET count, unfiltered pagination and reviewed complete provider IDs. It rejects writes, other clients, search filters and unreviewed IDs. The host's lock verifier runs before and in `finally` after every HTTP request.

Existing combined retirement fields remain intact. The additional reviewed fields are `sourceCommit`, `sourceInventorySha256` and `requirementsSha256`. The new normalized digest is `transientDatabaseSnapshotSha256`; it never replaces the older two-query `databaseSnapshotSha256`. A parent may retain a separate sanitized `transientSnapshot` prestate. Credential values/hashes are not added.

Actual fixed-query coverage:

| Query | Selected evidence |
| --- | --- |
| `shipments` | All Chit Chats generations, attached/unattached orders, public/provider refs, quote fingerprint/expiry, flat-rate/purpose/supersession, version/state, actual cost/currency/purchase time, signature and private body/rates/raw payload for normalization |
| `jobs` | All related job types, IDs/idempotency hash, state version, exact privately verified source payload hash, numeric/boolean intent projection, attempts, status, lease owner presence/expiry, availability/retry time, outcome code/unknown, completion/create/update timestamps |
| `rateCache` | Every zone/bucket/country/service/amount/currency, tracking/insurance and computation/create/update timestamps; explicitly not a provider completion receipt |
| `events` | All shipment event IDs, hashed fingerprints, provider/normalized state and event/create time; no descriptive text or raw event body |

The selected tables have no historical credential/tenant column. All Chit Chats rows are therefore conservatively included; unrelated/shared rows are preserved and cannot silently be filtered away.

The source interface uses families `chitchats.drafts`, `.postage`, `.refunds`, `.tracking`. Requirement IDs are `${familyId}.original-configuration`, `.durable-intents`, `.accepted-request-completeness`, plus source-wide SQL credential IDs. A source-owned `capabilityClosures` row must bind the exact family, accepted disposition, the exact sorted union of its three requirement arrays and global SQL credential requirements, and nonempty sorted evidence SHA256 IDs. The upstream reducer verifies original immutable configuration and every credential/intent source. The observer accepts that result; current disabled flags and generic booleans are not a closure. Source absence without the original capability/SQL closure also stays unresolved.

## Reconciliation rules

Provider enumeration uses unfiltered count/list pagination plus every detail read, followed by the same complete inventory again. Duplicate IDs, omitted rows, mismatching reviewed IDs, overflow, changed details or changed inventories refuse. These are consistency checks, not an absence/stable-interval proof.

A known unpurchased quote draft can be an acknowledged API effect when its unique provider object/public reference and persisted provider ID match, the private destination/package/customs/value/signature intent and stored provider snapshot match, and all operations have valid payload/idempotency receipts, positive attempts, success/completion, no held lease and no unknown outcome. Compatible future cleanup or use stays held. A reference-matching pre-acknowledgement orphan remains unresolved.

A purchased `ready/received/released/inducted/in_transit` shipment can be acknowledged without waiting for physical delivery, only with exact provider/order/postage/authoritative CAD amount/state and settled operation receipts. It produces deferred compatible work; future polling remains unauthorized. Provider purchase/refund processing, unsupported states, missing receipts, new effects, leases and unknown outcomes stay unresolved.

An exact C07 probe body/reference remains **unreceipted** because no durable request intent exists. A complete empty list, repeated list, rate-cache record or elapsed time cannot manufacture request completeness. There is no supported read endpoint here that reveals every in-flight pre-acknowledgement request. A reachable C07 family therefore needs an actual source-owned original no-capability closure or separately implemented positive exhaustive accepted-request evidence; otherwise the explicit gap remains null. This component has no caller boolean to suppress it.

## Primary API documentation

Reviewed [Chit Chats API v1](https://chitchats.com/docs/api/v1) on2026-11-05: the shipment list is paginated; `order_id` is the external order reference; count/list/detail are supported on staging. Shipment deletion is limited to eligible unpurchased objects. Buy acknowledgement may still be processing, and refund completion can require later provider reconciliation. The component performs only supported read calls and retains unsettled states. No live API, credential or database was accessed.

## Verification

`CRM_SHIPPING_OWNED_POSTGRES_TEST=true python3 -m unittest discover -s ops/platform/host -p frontend_chitchats_transient_effects_test.py -v`

The owned test fixture uses a trusted local HTTPS CA and an isolated PostgreSQL16 cluster with TLS hostname verification, SCRAM and all83 actual migrations. It covers real fixed SQL, draft/cache intent joins, persisted lease/payload faults, pre-ack orphan refusal, accepted purchased shipments, deletion receipts, source/closure mismatches, complete enumeration failures and PII-free outputs. The source payload hash is compared against the actual JavaScript canonicalization algorithm under Node24, including Unicode and mixed-case ASCII keys. No shared worker, application shipping source or old receipt is changed.

## Source-absence integration correction

`observe_scoped_effects(..., before=None)` accepts the immutable safe original snapshot from the shared worker. Only all four exact family and global SQL closures bound to the same source, surface, configuration record and provenance, together with complete empty original and current SQL snapshots, permit a no-client zero. This path needs no invented client ID. Partial closures and any present intent, lease, provider receipt or current provider object cannot override source contradiction checks. Actual provider reads retain the existing exact client/account requirement. The correction passes 21 owned HTTPS/actual PostgreSQL tests with all 83 migrations, including the actual C07 source getter, original configuration preparation, SQL collector and closure reducer. Original draft/purchase positive cases remain passing. The evidence addendum is `baselines/2026-11-05-chitchats-transient-effects/source-absence-correction.json`; no actual staging qualification is claimed.
