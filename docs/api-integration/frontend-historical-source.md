# Historical frontend source requirements

`ops/platform/frontend-historical-source.mjs` verifies checked source facts and reduces one original configuration's capabilities. It does not certify deployment retirement, provider request completion, absence of downstream effects, or release authorization. Current candidate admission cannot qualify an older revision.

The registry contains the four retained staging revisions, including C07 `b99d4f346696f897fa6a6729dfcc52d6503fe8d6`, and the 31 unique nonproduction preview revisions discovered in the other repository-linked project. Two overlap, producing 33 profiles. The additional project's name, a null deployment target, and a different SQL database provide no provider exclusion. Production-target-only revisions were not added or probed.

Each source-owned JSON profile pins its commit, tree, every selected runtime/build/manual code blob and SHA-256, route exports, tracked manual programs, schedules, server actions, render entrypoints, deferred continuations, dynamic execution sites, SQL sites, provider request sites, annotations, and actual lockfile SDK identities. Source selection includes code under `src/`, `scripts/`, and `ops/`, the package/lock and listed application/platform configuration, and workflow files; test-only files are excluded. This is a source inventory, not a proof that every recorded site executes. The fixed source requirements retain accepted-request uncertainty explicitly.

The runtime re-reads the actual Git objects, disables replacement objects, compares the full selected file set and blob hashes, verifies annotated excerpts, and checks a source-owned profile digest. A changed/unregistered commit, missing object, omitted file/family/requirement, or modified profile refuses verification. It never accepts a caller's completeness boolean. Platform source CI must fetch historical Git objects, rather than using a shallow candidate-only checkout.

The four staging revisions have reviewed credential/caller predicates. An additional preview may reuse those predicates only when its complete `src/` and tracked `scripts/` source, runtime configuration blobs, and provider SDK fingerprints match a reviewed revision. Other previews receive exact source facts and unresolved capabilities. No current C07 guard is presumed to exist in different older source. Adding a profile or predicate requires a reviewed source change; the generator is not an operational approval path.

## API and trust boundary

`verifiedSourceRequirements(repositoryRoot, fullSourceCommit)` returns a frozen, in-process branded object with `sourceCommit`, `treeOid`, `sourceInventorySha256`, `requirementsSha256`, `entrypoints`, `sdkDependencies`, `sqlCredentialRequirements`, and `providerFamilies`. Family IDs are stable across profiles. Every family has source configuration conditions, related durable SQL inventory requirements where present, and explicit untracked accepted-request/callback requirements. Related tables do not imply that every request has a pre-request intent. The global SQL requirements cover the actual application and supported direct-caller SQL configuration keys in that revision; unsupported operator programs remain inventoried and cannot obtain a direct-caller capability closure.

`prepareHistoricalSourceOriginalConfiguration(requirements, binding, originalConfiguration)` validates the private original record before the parent constructs SQL clients. It returns only configured SQL key names, expected role metadata, and source/configuration digests. It reads no current process configuration.

The parent must bind `binding.sourceConfiguration` to an actual accepted immutable deployment or direct-caller record. Its fields are `kind`, `immutableReference`, `entrypoint`, `keyCatalogSha256`, `provenanceSha256`, and `databaseRoles: [{key,name,oid}]`. `entrypoint` is null for a deployment; a direct caller must be one of the specifically reviewed tracked scripts. The enclosing binding supplies `surfaceSha256`, `sourceCommit`, and the existing `configurationRecordSha256`.

The private `originalConfiguration` contains matching `sourceCommit` and `configurationRecordSha256`, a complete sorted unique `keyCatalog`, and `environment` with exactly those own string-valued keys. Its nonsecret `provenance` binds the surface, source, original record digest, kind, immutable reference, entrypoint, and key-catalog digest. Optional `nonSecretSelectors: {APP_ENV}` is included in the provenance digest and must equal the actual original environment value. This enables only the reviewed original staging broadcast guard. A current/default staging value does not qualify. The parent must not synthesize the catalog from a current environment or a selected provider subset. Missing original provenance is an evidence gap.

`historicalSourceSqlCredentialQueryPlan(requirements)` exposes fixed metadata-only identity/parent-marker queries. `observeHistoricalSourceSqlCredentials(requirements, input)` requires the exact configured SQL client map, expected role for every present source SQL key, authorized TLS, private equality with the original URL's explicit host/port/database/user/password, actual current/session role and OID, PostgreSQL 16 or 18, read-only defaults, and four unpredictable advisory markers held by the actual parent in the same physical database. `verifySession` runs before, between, and after observations. Alternative physical databases may be supplied per key for metadata-only identity observation; their existence does not close provider capability. Implicit/default PostgreSQL credentials, omitted clients, extra clients, and masked/empty URLs refuse observation.

`deriveHistoricalSourceCapabilityClosures(requirements, binding, originalConfiguration, sqlEvidence)` accepts only this module's in-process source and SQL observations. It rejects serialized/constructed proofs, changed private values/roles, and evidence copied across configurations or surfaces. Output includes all source/configuration context fields, `capabilityClosures`, and `unresolvedFamilyIds`. Each closure includes those context fields, an explicit disposition, the exact sorted union of all three family requirement arrays plus **every** global SQL credential requirement, and sorted evidence digests. The parent must keep each surface's closures separate even when Git source is identical.

Absence means a required key is absent from the verified **complete original key catalog**. A retained masked, empty, malformed, disabled, or currently unavailable value remains potentially capable. Original runtime flags alone do not close a family because alternate direct/manual/callback paths exist. Narrow additional source predicates cover reviewed deployed template mutation inapplicability and the original staging broadcast create/send guard. Google legacy Redis credentials, Sanity/Studio, and unrelated Mux Studio capabilities remain unresolved. A source-inapplicable private Course Mux writer is recorded separately from Studio/public media.

## Required historical uncertainty

| Scope | Exact C07 source finding | Required consequence |
| --- | --- | --- |
| ChitChats | `flat-rate-refresh.ts:133` creates a transient probe outside shipment/job intent; delete at 193 is best effort. Worker creates at 247/703 precede provider reference persistence. | Current cache/jobs or stable empty draft lists cannot prove no accepted transient request. |
| Square | Customer/card/invoice/order/hosted-link creation can precede SQL/checkpoint persistence; V1 payment lacks V2 durable recovery. | Inventory all eight financial/registration families and preserve lost acknowledgments. The 12 actual financial tables exclude `training_enrollments`, which has no independent Square intent. |
| HighLevel | Workflow enrollment acknowledgments are separate from downstream execution. Removal acknowledgments, privacy scrubbing, and retention limit historical SQL meaning. Direct contact PUT/DELETE paths lack per-request intent. | Empty/current effect rows, `sent`, or scrubbed `cancelled` rows cannot establish workflow/downstream completion. Conversation/message absence is not inferred from direct SDK absence. |
| Resend | Contact synchronization can swallow `events.send` failure while recording the job succeeded. Broadcast/template/automation wrappers and tracked manual callers exist. | Events, contacts, segments, topics, broadcasts, templates, automations and callbacks all require source-specific treatment. Unsubscribe receipts use `marketing_consent_events`; no `resend_webhook_receipts` table is invented. |
| Google | SQL grants coexist with scoped/unscoped legacy Redis tokens; provider insertion can precede stored calendar IDs. | Empty SQL or revoked current clients do not prove complete request history. |

All remaining source-capable untracked requests remain unknown until actual provider/lifetime/callback/persistence evidence closes them. These requirements are per source/configuration, and do not establish the earliest provider-capable lifetime from an arbitrary API list window.

## Executed qualification

The frozen baseline at `baselines/2026-11-05-p2-historical-source/` records 12 passing source/configuration/tamper tests, all 33 actual Git inventories, and 10 passing owned PostgreSQL 16 checks with four actual TLS/SCRAM read-only credential peers and 17 parent-session checkpoints. The owned run rejects foreign markers, wrong actual role OID, connected-peer credential mismatch, a writable session, and serialized proof substitution. All original configuration values are synthetic fixture data; no actual deployment original record or provider was accessed. An initial sandbox socket refusal and a corrected protocol-fixture assertion are retained in `attempts.json`.

Reproduce the unit checks with Node 24:

```sh
node --test ops/platform/frontend-historical-source.test.mjs
```

The explicit owned loopback fixture is:

```sh
FRONTEND_HISTORICAL_SOURCE_OWNED_TEST=true PG_BIN=/path/to/postgresql/bin \
  node docs/api-integration/baselines/2026-11-05-p2-historical-source/run-owned.mjs
```

It accepts PostgreSQL 16 or explicit `OWNED_POSTGRES_MAJOR=18`, creates a fresh cluster, reads no configured database URL, and destroys its owned peers and cluster. Profile regeneration is a separate review operation, `generate-reviewed-profiles.mjs --write-reviewed-profiles`; its output must be reviewed and committed with the checker pins. None of these artifacts authorizes live activation, production operations, provider mutation, automatic replay, or release.
