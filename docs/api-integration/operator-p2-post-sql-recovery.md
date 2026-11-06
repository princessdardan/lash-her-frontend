# P2 post-SQL deliberate recovery

The new entry point is `ops/platform/p2-recovery.mjs`. It restores only the **same qualified candidate** with an already retained, promoted READY frontend. It has a distinct `recoveryActionId`; it preserves the original candidate bytes, release ID, three application sources, image/SQL/contracts/schema digests, configuration and original receipt hashes. No live recovery was performed during source qualification.

The first supported mode is `frontendMode: "reuse-retained-ready"`. Failed, canceled, unknown or never-started builds need a separately implemented forward action. That remains **OPEN**. This mode never repeats a deployment/promotion POST, invokes frontend/API migration execution, creates roles or restores historical LOGIN.

## Reviewed inputs

Reuse the original P2 settings fields (`bundle`, `inventory`, `configuration`, `host`, `providerContext`, `knownHosts`, `sshKey`) and add:

- `operatorSourceCommit`: the separately CI-qualified committed recovery-tooling revision. The original candidate keeps its original frontend application revision.
- `originalDirectory`: the private original frontend receipt directory.
- `results`: a private output parent outside any checkout. Each recovery creates an exclusive directory named by its new action.
- `recovery`: version1/staging, distinct `recoveryActionId`, original `originalReleaseId`/`sourceCommit`, original raw `candidateSha256`, normalized original `inventorySha256`, and the hash of the complete original `configurationSha256` map.
- `originalReceiptSha256`: exact hashes for the original `frontend-release-started.json`, `database-receipt.json`, `job-outcome.json` and retained `vercel/frontend-{build-started,build-created,build-outcome,promotion-started,workload-outcome}.json`. A missing original database receipt or terminal is explicitly `null`; actual filesystem absence is checked. The five READY-mode Vercel receipts must exist and be hash-bound. Additional original JSON receipts may be pinned.

Use the observed original inventory with actual prepared owner/runtime OIDs and original role-proof binding. Recovery refuses desired-name-only role preparation. The runtime producer remains the original explicitly selected producer; other declared producers are preserved.

```sh
node ops/platform/p2-recovery.mjs plan /private/reviewed-recovery-settings.json
node ops/platform/p2-recovery.mjs apply /private/reviewed-recovery-settings.json --confirm staging/REVIEWED_RECOVERY_ACTION_ID
```

Node24 is required. Actual staging execution requires Dardan's reviewed start for that exact recovery action. The commands above document the interface and were not run against staging. Existing selected credentials are supplied privately at runtime; AWS-held values use the existing `asm-exec` dynamic-reference flow. No secret fetch, credential value, URL password, SSH token or private provider response belongs in arguments or logs.

## Execution and evidence

The fixed SSH entry `host/p2_recovery_supervisor.py` invokes the shared supervisor with source-selected recovery broker/observer types and a fixed recovery receipt/runtime layout. JSON cannot select modules, an executor, a lock path or a success callback. The independent supervisor and broker retain the same actual host flock descriptor; the operator retains a **new actual frontend PostgreSQL session**, migration advisory lock and random marker. There is no nested host lock, local Docker assumption or host Node dependency.

Recovery arms the independent guard before provider observations or runtime startup. The new `P2RecoveryScope` accepts only a fresh `P2_RECOVERY_DATABASE_CURRENT` observation, rather than inventing an original `DATABASE_VERIFIED` terminal. That observation verifies complete current FE journal/schema, restricted runtime/default/admission grants, exact prepared OIDs, all five admission routine source bodies/security properties, producer registrations, closed/drained admission, denied old logins and zero old-role sessions. Source-body hashes are embedded in the self-contained observer because the original migration image does not contain the admission bootstrap SQL file.

The complete retained build/promotion state is reconciled first through GET. Unknown/missing intent or mismatching source/profile refuses before startup. Each API migration image then runs `p2-recovery-api-current-probe.mjs`: read-only transaction, actual identity/TLS, complete source lineage, exact catalog and runtime-role grants. The original manifests and approved pending tags are unchanged. Any pending/unknown API migration refuses this recovery mode.

Only after **both** APIs are current does the typed runtime component preflight the original configuration and restore the exact10 reviewed services through the existing fixed stage order. It never calls a migration executor. All commands are registered under the scope. Boundary/container checks remain mandatory.

A separate fresh authenticated phase2 HTTPS GET rechecks the selected READY deployment, actual ten feature controls, actual `mode: enforce` writer target/producer/source/role binding and the frontend-to-gateway Course transport. It uses the existing private probe configuration and no new signer or provider environment mutation. Its new receipt is separate from the original workload hash. An expired original probe cannot be extended in this immutable deployment and remains a review condition.

Restoration follows the existing account policy: **recovery, then new work**. Before each gateway change, the host independently rereads the actual frontend admission state. Both frontend and gateway boundaries, exact current source/configuration, retired credentials and provider fences remain checked under the guard. Native schedules stay disabled; provider ingress remains retired. Successful restoration is `P2_STAGING_RECOVERY_RESTORATION_VERIFIED`, not whole-release/G2 acceptance.

Interruption, lost lock/session, stale original receipt, changed source/configuration, missing/unknown provider effect, role drift, failed API verification or frontend mismatch revokes the scope. The independent guard reaps worker processes, attempts both admission closures and stops the runtime. Failed cleanup observations remain `null`/uncertain; failure does not claim successful closure. Old receipts remain immutable and SQL is never replayed.

Vercel's [deployment GET reference](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url) documents the read used for retained READY/source reconciliation. This implementation does not infer immutable deployment bindings from mutable project environment flags.

## Owned verification

Focused source and physical flock/pipe/provider tests:

```sh
node --import ./node_modules/tsx/dist/loader.mjs --test ops/platform/p2-post-sql-recovery.test.mjs ops/platform/p2-recovery-transport.test.mjs
python3 -m unittest discover -s ops/platform/host -p p2_recovery_test.py -v
```

The actual three-database fixture has **no optional skip**:

```sh
P2_RECOVERY_OWNED_TEST=true OWNED_POSTGRES_MAJOR=18 \
PG_BIN=/usr/lib/postgresql/18/bin NODE_BIN=/usr/local/bin/node \
COURSE_RECOVERY_SOURCE_ROOT=/exact-sources/lash-her-course-api \
COMMUNITY_RECOVERY_SOURCE_ROOT=/exact-sources/lash-her-community-api \
python3 ops/platform/test-p2-recovery-owned.py
```

It requires Python3, openssl, the explicitly selected PostgreSQL16 or18 binaries, Node24 and frontend `tsx`/`pg` dependencies. It creates/removes its own loopback-only TLS/SCRAM cluster and all three databases with generated synthetic credentials. It never reads an ambient database URL.

The API roots must be the exact prepared source checkouts, including their `drizzle` artifacts and resolvable installed JavaScript dependencies. The fixture imports `src/db/operator-migration.ts`, `migration-lineage.ts`, `migration-schema.ts` and their source-local dependencies through the frontend TSX loader; those modules resolve `zod`4, `pg` and `drizzle-orm` from the API checkout's normal Node resolution. It performs no dependency install/copy or qualified-source substitution. Missing API sources/dependencies or a binary-major mismatch fails the fixture. The current owned sources contain83 FE,22 Course and11 Community migrations.

Local PostgreSQL16 qualification passed14 physical checks, including missing current lineage, stale owner OID, changed owner privilege, open admission, changed routine body, old LOGIN/session denial, lock-session death and both current/noncurrent API databases. PostgreSQL18 is required in CI and was not available locally. Docker/runtime/provider tests use owned process/HTTPS fixtures; no Docker Desktop or live cloud operation was used. Evidence records these limits explicitly.
