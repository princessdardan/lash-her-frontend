# Pending frontend SQL coordination component

This is an isolated P2-00 component, not live release qualification. It composes the existing physical-session migration runner, admission ledger and historical-login retirement. It does not change the legacy staging CLI, enable pending frontend SQL there, touch PR #91, acquire credentials, restore admission/schedules or implement production orchestration.

The authoritative [release policy](release-policy.md), [migration policy](migration-policy.md) and current release-coordination brief still apply. Existing successful staging SQL/C3 work must not be replayed. A component result is not a new release approval or P2-00/G2 acceptance.

## Inputs and boundaries

`prepareFrontendReleaseCoordination(candidate, job, baseline, inventory)` is credential-, database- and provider-free. It reuses `prepareFrontendMigration` for exact source, CI/candidate, migration image, SQL, contract, schema, direct target and reviewed pending chain bindings. This component accepts staging with pending SQL only; the established already-current read-only path remains separate.

The inventory binds:

- Action/source and the exact environment/host/port/database/operator/server-major target hash from `frontendAdmissionTargetSha256`.
- The complete `frontendWriterInventory` artifact hash. `frontendCandidateSurfaces` derives stable IDs for every discovered route method, server action/export, inline action, deferred site, database constructor and native schedule. Coverage must contain each exact ID once, with an admitted/read-only/closed disposition and retained evidence hash. Admitted surfaces identify a selected producer.
- Explicit protocol producer hashes, database role names/OIDs and a separate NOLOGIN admission owner. New producer/source registration must already match the reviewed bootstrap or existing ledger; this component does not silently adopt an unregistered new writer.
- Explicit external deployment, provider, scheduler and direct-caller surfaces. Every surface has a kind, identity digest and derived surface digest. Retained/historical URLs, previews, callbacks/retries, manual scripts and all affected credential scopes belong here. The cluster-scope historical-role artifact must account for every affected database/branch, not just the selected database.
- The exact source hash of the fixed `ops/platform/frontend-release-adapters.mjs` implementation, a reference to the existing reviewed inventory evidence, admission mode/epoch, the separate bootstrap SQL hash when selected, and a maximum 300-second observation budget.

Source enumeration cannot discover retained deployments, provider bindings or credential reuse. Matching IDs and evidence hashes prove consistent coverage of the supplied inventory; they do not establish that the external inventory is exhaustive. That inventory and actual adapter implementation remain required qualification work. No arbitrary `approved` or `historicalWritersFenced` input substitutes for them.

## Locked execution

`runFrontendReleaseCoordination(prepared, dependencies)` requires the exact `staging/ACTION_ID` confirmation, private empty action directory and explicit runtime credential supplier. It checks clean pinned source before loading adapter code or acquiring credentials. Receipts copy known fields only. No CLI or ambient URL fallback is introduced.

The environment lock uses the same native flock path as existing host release/watchdog tooling. The guardian retains the physical descriptor through the action; inode replacement, contention or guardian loss refuses. Guardian loss aborts the lease and ends the migration connection, preventing further SQL on that session. Provider adapters must honor the supplied abort signal and await cancellation/outstanding requests; a lost acknowledgement remains uncertain.

The migration runner owns its original connection lifecycle. Its new in-process `beforeDatabasePreflight({client, verifySession})` hook runs after TLS/identity and advisory-lock acquisition, before lineage reads or application SQL. It checks the same physical backend and held lock before and after the hook. Existing standalone behavior is unchanged; JSON cannot supply a hook.

Inside that hook the parent:

1. Optionally installs the separately hashed `frontend-admission.sql` artifact once, as the selected NOLOGIN owner in one transaction. It touches only `frontend_admission`, binds producer OIDs/source, removes direct runtime table/DDL grants and grants protocol USAGE/EXECUTE. New-work and recovery controls remain closed. Existing schema, changed roles, lost commit acknowledgement or missing durable receipts refuses; there is no idempotent bootstrap retry.
2. Closes new work while retaining the current eligible recovery setting. The source-pinned adapter suspends/fences reviewed external producers; the actual historical-login component disables the selected logins, terminates their recorded sessions and verifies the result. Neither output establishes whole-provider drain.
3. Observes the durable ledger while admitted/eligible recovery work settles, then closes recovery and requires zero active **and** uncertain operations. Age never clears uncertainty. The monotonic budget covers fencing, retirement and drain; an over-budget observation cannot authorize SQL. Slow/uncertain effects are awaited and refused, not detached while locks are released.
4. Independently observes every external surface after both controls close. It validates action/source/target/inventory, a fresh nonce and exact retained evidence bytes/hashes. Unresolved effects or missing evidence refuses before application SQL.
5. Lets the existing runner verify complete lineage and apply the reviewed pending forward chain once. The same physical advisory lock and environment lock remain held through schema/journal/runtime-grant verification and the in-process compatible frontend build, workload verification and observed promotion. Source/locks and external fences are checked again before completion.

The current-version producer rows must be verified against the plan before SQL; existing disabled historical rows can remain for operation history. This component refuses incomplete/mismatched registrations rather than changing source identities behind an existing producer digest.

The result is `FRONTEND_SQL_AND_COMPATIBLE_DEPLOYMENT_VERIFIED_HELD`, with traffic/admission/schedule restoration and whole-release acceptance false. It is a component receipt for the reviewed parent release, not a new migration authority. Existing original database receipts remain authoritative when a later frontend/provider stage fails.

## Required fixed adapter

The fixed adapter now exists; its [concrete Vercel components](frontend-vercel-release-adapter.md) compose the existing scheduler/build/workload/promotion implementation. Loading it requires its exact hash in the reviewed inventory and clean candidate source. Its module initialization is credential- and side-effect-free; operations belong inside locked exports. Historical deployment/provider credential and callback fencing remains unsupported, is recorded explicitly, and always refuses whole-fence completion. Creating success-shaped JSON does not supply those missing capabilities.

The adapter must implement these in-process exports using actual provider operations:

| Export | Required behavior |
| --- | --- |
| `fenceFrontendExternalProducers(context)` | Currently captures concrete staging metadata when runtime context is available, records missing historical/vendor/callback capabilities and refuses. It does not mutate providers or infer a fence from project/schedule disablement. Whole-fence qualification must eventually retire bypassing access and reconcile actual outstanding effects. |
| `observeFrontendExternalFences(context)` | Independently read every exact external surface; bind the fresh nonce, action, source, target and inventory. Return per-surface proof bytes plus the actual observation and reconciliation bytes, with matching hashes. The coordinator durably retains all three before SQL. |
| `deployCompatibleFrontend(context)` | Compose the existing verified provider build/workload/promotion behavior using the exact candidate source/project and completed database receipt. Keep admission and native schedules closed, verify the lock between stages, retain intents/partial outcomes, and never retry an uncertain mutation. |
| `observeCompatibleFrontend(context)` | Read actual build/project/alias-job/scheduler state independently. Return bounded retained evidence bound to action/source/target/project/deployment and workload receipt. Recovery observations must also represent absent, pending or failed deployments without mutating them. |

Fence observation responses contain `version`, `nonce`, `actionId`, `sourceCommit`, `targetSha256`, `inventorySha256` and one row per external surface. Each row contains `surfaceSha256`, `evidence`/`evidenceSha256`, `observation` and `reconciliation` Buffers. Proof JSON binds the same identities and includes the exact observation/reconciliation hashes, `activeExecutions`, `uncertainEffects` and the surface-specific fence state. Each retained item is limited to 2 MB; a checkpoint is limited to 32 MB. No raw credentials, customer records or private schema exports belong in those files.

Only these completed states permit SQL: provider credentials retired and effects reconciled; scheduler disabled and running executions reconciled; deployment/direct caller retired or bound to admission with effects reconciled. Counts must both be zero. A receiver/provider outage, missing inventory surface or evidence-write failure refuses. The live adapter still needs exhaustive deployment/provider qualification, actual capture/callback/worker failure coverage and integration with the final operator action.

## Deliberate recovery

`prepareFrontendReleaseRecovery` selects a distinct recovery action and binds the original action's immutable started-receipt hash plus the existing reconciliation-review reference. `observeFrontendReleaseRecovery` writes only to a new private action directory and acquires the same environment/physical advisory locks. Its database connection enforces `default_transaction_read_only=on`.

Recovery reads actual complete migration lineage, schema-baseline agreement, selected historical role OIDs/LOGIN/session state, admission controls and unresolved counts. It records current external observations even when unfenced, and actual provider build/promotion state. It preserves original success/failure receipts and returns `FRONTEND_RELEASE_STATE_OBSERVED_REVIEW_REQUIRED`; it never calls migration apply, bootstrap, producer fencing, deployment, LOGIN, reconciliation, admission reopening or schedule restoration. A reviewed forward fix/restoration remains a separate deliberate action with its own actual-state checks.

## Verification and remaining work

Focused Node24 tests cover pure refusal/coverage, closed bootstrap, lost commit acknowledgement, exact evidence retention, native lock contention/inode replacement, exclusive receipts and unbound-adapter refusal. Migration-core regression tests prove the original physical client reaches the new hook before lineage/SQL, and hook failure, socket loss, lock loss or serialized callbacks refuse before application SQL.

The independent owned rehearsal creates a fresh PostgreSQL TLS cluster, generates local-only credentials and commits a disposable source tree containing an adapter that uses an owned loopback HTTP provider model:

```sh
FRONTEND_RELEASE_LOCAL_TEST=true PG_BIN=/absolute/path/to/postgresql/bin node ops/platform/test-frontend-release-local.mjs
```

It verifies real closed bootstrap/login retirement/full SQL/compatible promotion, environment/advisory contention during build and promotion, admitted deferred work remaining active after new-work closure, persistent uncertainty and mismatched producer registrations refusing before SQL, missing durable database receipts after committed SQL, actual migration-backend/environment-lock loss before promotion, and lost promotion acknowledgement followed by a distinct read-only recovery observation with unchanged original receipts and no replay. Its candidate/coverage/provider evidence is synthetic owned-fixture evidence and cannot qualify real writers, CI or providers. PostgreSQL16 was executed locally. PostgreSQL18 remains to be run in the owning CI/container environment; no PostgreSQL18 or live-provider qualification is claimed here.

Real coverage evidence for all candidate writers, an exhaustive deployment/provider inventory, supported historical/provider/callback fencing, restoration/host integration and live qualification remain open. The existing staging entrypoint/pending-SQL refusal remains intact until the complete path is reviewed and qualified under the existing single-operator policy.
