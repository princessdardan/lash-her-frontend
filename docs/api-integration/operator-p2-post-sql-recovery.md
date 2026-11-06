# P2 post-SQL deliberate recovery

The entry point is `ops/platform/p2-recovery.mjs`. It restores only the **same qualified candidate**. It has a distinct `recoveryActionId`; it preserves the original candidate bytes, release ID, three application sources, image/SQL/contracts/schema digests, configuration and original receipt hashes. No live recovery was performed during source qualification.

`frontendMode: "reuse-retained-ready"` requires the original promoted READY frontend and never repeats a deployment or promotion POST. `frontendMode: "reviewed-new-build"` is a separately reviewed new action for exactly one of these retained source states: an identified failed build, an identified canceled build, or a promoted READY build whose retained private workload probe has expired. Both modes forbid frontend/API migration execution, role preparation, historical LOGIN restoration, SQL replay and reconstruction of the original terminal.

Unknown or lost build POST outcomes without a deployment ID, never-started builds, missing original receipts and unreviewed source states remain closed. A failed forward attempt is not retried in the same action. Reconciliation or another build requires a new reviewed action and a new empty private configuration directory.

## Reviewed inputs

Reuse the original P2 settings fields (`bundle`, `inventory`, `configuration`, `host`, `providerContext`, `knownHosts`, `sshKey`) and add:

- `operatorSourceCommit`: the separately CI-qualified committed recovery-tooling revision. The original candidate keeps its original frontend application revision.
- `originalDirectory`: the private original frontend receipt directory.
- `results`: a private output parent outside any checkout. Each recovery creates an exclusive directory named by its new action.
- `recovery`: version1/staging, distinct `recoveryActionId`, original `originalReleaseId`/`sourceCommit`, original raw `candidateSha256`, normalized original `inventorySha256`, and the hash of the complete original `configurationSha256` map.
- `originalReceiptSha256`: exact hashes for the original `frontend-release-started.json`, `database-receipt.json`, `job-outcome.json` and retained `vercel/frontend-{build-started,build-created,build-outcome,promotion-started,workload-outcome}.json`. A missing original database receipt or terminal is explicitly `null`; actual filesystem absence is checked. The five READY-mode Vercel receipts must exist and be hash-bound. Additional original JSON receipts may be pinned.
- For `reviewed-new-build`, `forwardReason` is exactly `prior-build-failed`, `prior-build-canceled`, or `retained-ready-probe-expired`; `forwardPrivateConfigurationDirectory` is a new absolute private path. Failed/canceled sources require the original promotion-started and workload-outcome receipts to be absent. Expired READY sources require hashes for the original promotion, workload and probe-preparation receipts.

Use the observed original inventory with actual prepared owner/runtime OIDs and original role-proof binding. Recovery refuses desired-name-only role preparation. The runtime producer remains the original explicitly selected producer; other declared producers are preserved.

```sh
node ops/platform/p2-recovery.mjs plan /private/reviewed-recovery-settings.json
node ops/platform/p2-recovery.mjs apply /private/reviewed-recovery-settings.json --confirm staging/REVIEWED_RECOVERY_ACTION_ID
```

Node24 is required. Actual staging execution requires Dardan's reviewed start for that exact recovery action. The commands above document the interface and were not run against staging. Existing selected credentials are supplied privately at runtime; AWS-held values use the existing `asm-exec` dynamic-reference flow. No secret fetch, credential value, URL password, SSH token or private provider response belongs in arguments or logs.

## Execution and evidence

The fixed SSH entry `host/p2_recovery_supervisor.py` invokes the shared supervisor with source-selected recovery broker/observer types and a fixed recovery receipt/runtime layout. JSON cannot select modules, an executor, a lock path or a success callback. The independent supervisor and broker retain the same actual host flock descriptor; the operator retains a **new actual frontend PostgreSQL session**, migration advisory lock and random marker. There is no nested host lock, local Docker assumption or host Node dependency.

Recovery arms the independent guard before provider observations or runtime startup. The new `P2RecoveryScope` accepts only a fresh `P2_RECOVERY_DATABASE_CURRENT` observation, rather than inventing an original `DATABASE_VERIFIED` terminal. That observation verifies complete current FE journal/schema, restricted runtime/default/admission grants, exact prepared OIDs, all five admission routine source bodies/security properties, producer registrations, closed/drained admission, denied old logins and zero old-role sessions. Source-body hashes are embedded in the self-contained observer because the original migration image does not contain the admission bootstrap SQL file.

The complete retained build/promotion state is reconciled first through GET. Unknown/missing intent or mismatching source/profile refuses before startup. For a reviewed forward action, this GET reconciliation must prove the exact eligible failed, canceled, or expired READY source before any new mutation. Each API migration image then runs `p2-recovery-api-current-probe.mjs`: read-only transaction, actual identity/TLS, complete source lineage, exact catalog and runtime-role grants. The original manifests and approved pending tags are unchanged. Any pending/unknown API migration refuses both recovery modes.

After current frontend and both current API proofs, forward mode records an exclusive intent and performs at most one reviewed build and one promotion for the new action. Its new private probe directory must be canonically disjoint in both ancestor directions from the original common receipts, new common receipts and old private configuration. The CLI checks this before creating either output directory, and the host builder checks it again before creating an attempt or calling the provider.

Every forward guard authenticates the exact privately captured runtime database URL through a fresh verified-TLS, read-only connection. The role OID, database OID/name and PostgreSQL major must match the current proof, and that connection must observe both the actual parent migration lock and its random marker on the selected database. The URL remains pinned in private memory for the action. No credential-derived digest is published and no application table is queried by this login check. Incorrect/stale credentials, a different physical database, or private-context drift refuse before provider mutation.

Every provider mutation has a prior immutable intent. The new deployment is pinned to the original source and release ID plus the distinct recovery action metadata. The six new build/workload/promotion receipts, actual P2 feature profile, writer-admission binding, schedule state and exact workload bytes are revalidated under the live database session before restoration. The host receives those newly verified workload bytes; forward mode cannot fall back to the original workload receipt. The host also requires the exact P2 phase/manifest pair before persisting or joining a terminal receipt.

Recovery requires the exact API image's named read-only `verifyOperatorRoles` export. An older image without that reviewed gate refuses; there is no copied weaker policy or migration-executor fallback. Fresh P2 image/source qualification must include that export. The frontend verifier checks inbound and outbound owner/runtime memberships during initial and continuous observation. It preserves only the original authenticated operator's exact role-preparation grants: owner SET without INHERIT or ADMIN, and PostgreSQL16+ automatic creator ADMIN grants without SET or INHERIT. Arbitrary members, grant options, sequence UPDATE, excess table privileges, and unexpected/global default grants refuse before restoration. This follows the existing role-preparation policy and PostgreSQL's documented [membership options](https://www.postgresql.org/docs/16/catalog-pg-auth-members.html) and [global/per-schema defaults](https://www.postgresql.org/docs/18/sql-alterdefaultprivileges.html).

The fixed managed-provider operator must retain LOGIN/CREATEROLE and remain NOSUPERUSER. Its CREATEDB, INHERIT, REPLICATION and BYPASSRLS capabilities are preserved; they are not the restricted runtime policy. The selected admission owner/runtime must retain the preparation's empty role settings, unlimited connection limit and no credential expiry, with no per-database role overrides. Runtime ownership or effective USAGE on an unapproved non-system schema refuses, including access inherited through PUBLIC. Only public data and the frontend_admission protocol are approved runtime schemas; system/TEMP privileges are preserved. Operator/provider ownership of other schemas is permitted. Neon's [role documentation](https://neon.com/docs/manage/roles) explains its administrative role capabilities.

Both frontend recovery connections and the API current-only connection use a constant startup search_path of pg_catalog,public, appended to existing connection options. Catalogs resolve before user schemas while public type/expression rendering stays compatible with the original immutable schema baseline. Verification does not depend on operator/database search_path settings. The mandatory API role gate runs before lineage/catalog readers.

Only after **both** APIs are current does the typed runtime component preflight the original configuration and restore the exact10 reviewed services through the existing fixed stage order. It never calls a migration executor. All commands are registered under the scope. Boundary/container checks remain mandatory.

A separate fresh authenticated phase2 HTTPS GET rechecks the selected READY deployment, actual ten feature controls, actual `mode: enforce` writer target/producer/source/role binding and the frontend-to-gateway Course transport. Reuse mode uses the retained private probe configuration and no new signer or provider environment mutation. Forward mode uses only its new exclusive private configuration and workload receipt. An expired original probe is evidence for the reviewed forward reason; it is never extended or rewritten in the original receipt directory.

Restoration follows the existing account policy: **recovery, then new work**. Before each gateway change, the host independently rereads the actual frontend admission state. Both frontend and gateway boundaries, exact current source/configuration, retired credentials and provider fences remain checked under the guard. Native schedules stay disabled; provider ingress remains retired. Successful restoration is `P2_STAGING_RECOVERY_RESTORATION_VERIFIED`, not whole-release/G2 acceptance.

Interruption, lost lock/session, stale original receipt, changed source/configuration, missing/unknown provider effect, role drift, failed API verification or frontend mismatch revokes the scope. The independent guard reaps worker processes, attempts both admission closures and stops the runtime. Failed cleanup observations remain `null`/uncertain; failure does not claim successful closure. Old receipts remain immutable and SQL is never replayed. A lost forward provider response stays uncertain and does not authorize another POST in the same action.

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

The Node child receives only PATH/HOME/LANG/LC_*/TMPDIR plus generated owned-fixture inputs and its generated CA. NODE_OPTIONS, NODE_PATH, TSX settings, ambient database/provider values and other shell configuration are excluded. The fixture executes a synthetic NODE_OPTIONS sentinel as a positive control, then poisons its parent environment and proves the actual qualification child never executes that sentinel. Owned probe sequences are included in the generated catalog baselines so sequence-ACL faults exercise privilege verification even when application migrations use UUIDs.

The API roots must be the exact prepared source checkouts, including their `drizzle` artifacts and resolvable installed JavaScript dependencies. The fixture imports `src/db/operator-migration.ts`, `migration-lineage.ts`, `migration-schema.ts` and their source-local dependencies through the frontend TSX loader; those modules resolve `zod`4, `pg` and `drizzle-orm` from the API checkout's normal Node resolution. It performs no dependency install/copy or qualified-source substitution. Missing API sources/dependencies or a binary-major mismatch fails the fixture. The current owned sources contain83 FE,22 Course and11 Community migrations.

Local PostgreSQL16 qualification passed14 physical checks, including missing current lineage, stale owner OID, changed owner privilege, open admission, changed routine body, old LOGIN/session denial, lock-session death and both current/noncurrent API databases. PostgreSQL18 is required in CI and was not available locally. Docker/runtime/provider tests use owned process/HTTPS fixtures; no Docker Desktop or live cloud operation was used. Evidence records these limits explicitly.

The original14-check receipt is historical and does not qualify the later privilege correction. The separate `2026-11-05-p2-recovery-role-correction` evidence retains the original unsafe accepted-fault reproduction and records the corrected checks against the exact API source exports. Initial and continuous frontend faults must leave actual admission closed and never enter restoration.

The final role-closure receipt is `role-closure-owned-postgres16.log`, bound by `role-closure-validation.json` in that evidence directory. It passed55 groups with39 named regression cases, including17 frontend initial/continuous refusals and22 API refusals, plus two missing-export refusals. Actual operator/database catalog shadows, protected global/per-database settings, and a PUBLIC-accessible runtime-named shadow schema are exercised. The earlier50-check proof is preserved as a partial historical receipt. The SUPERUSER case hardens the supported provider profile; an attempted compound one-row escalation setup was rejected with SQLSTATE42501 and is not evidence of an accepted bypass. PostgreSQL18 CI, independent final commit review and the reviewed actual staging start remain separate requirements.
