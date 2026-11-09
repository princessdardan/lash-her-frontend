# P2 staging frontend database replacement review

The November 9 read-only recheck confirmed that the staging frontend database still has 80 of 83 migrations applied through `0079_highlevel_marketing_ownership`. Its three pending migrations cover customer identity, auth throttling and account lifecycle. The source-owned current-only release requires a complete journal. The retained historical deployment configuration needed to qualify a forward migration on that database is unavailable. [Staging journal recheck](baselines/2026-11-09-p2-staging-frontend-lineage.json) · [Historical configuration decision](decisions/2026-11-06-original-frontend-config-unavailable.md).

The proposed path uses a distinct, empty PostgreSQL 16 or 18 frontend target under the existing staging administration. Reuse the staging Vercel project and origin, API staging targets and gateway subject to their own exact binding checks. Preserve the predecessor database, deployment and recovery reference. The earlier `p2q_frontend` proposal supplies a possible database label. Actual provider and PostgreSQL target identifiers are open. [Resource-reuse decision](decisions/2026-11-06-p2q-resource-reuse.md).

## Target selection

1. Identify a distinct empty target in the existing provider organization. For Neon, review the project, branch and direct endpoint IDs together. Neon branches can copy roles, schema and data from a parent. A sibling database on the predecessor branch still shares its roles. The stock verifier requires the predecessor runtime and fixed preparation roles to be absent on the replacement cluster. An existing empty target can qualify if its actual scope and catalog pass. [Neon object hierarchy](https://neon.com/blog/neon-object-hierarchy).
2. Retain the exact direct TLS host, port, database, PostgreSQL major, database owner and OID, migration login and OID, runtime role name and every approved effective administrator login and OID. Compare with the predecessor's independently retained provider resource and database identity. Record who owns the selected target and where the compatible predecessor deployment and rollback inputs are retained. Keep the migration and generated runtime credentials in the private handoff.
3. Confirm the selected target's catalog behavior on its actual PostgreSQL service before binding any frontend. Check that the migration login owns the database, that `PUBLIC` lacks `CONNECT`, `TEMP` and `CREATE`, and that only reviewed roles can connect. The stock boundary also inspects schemas, extensions, subscriptions, prepared transactions and the absence of other client sessions. The disposable tests cover stock PostgreSQL 16 and 18. A managed provider's roles and catalog permissions require actual evidence before selection. The verifier is `ops/platform/frontend-replacement-boundary.mjs` in the frontend integration source.
4. Review the exact candidate's frontend producers and selected provider bindings. Keep predecessor deployments, preview callbacks, historical callers and recovery on their original database and credentials. Keep new callback bindings and schedules closed until separately qualified. Record the scoped split of effects and the destination for the new frontend runtime credential. The approved certification exclusions for retained financial-history smoke and integrations lacking a qualified setup still apply. Paid-grant certification remains required.

## Offline review command

Run the fixed planner from the reviewed frontend checkout with Node 24. The bundle contains `release.candidate.json`, `jobs/frontend.json` and `schema/frontend.json`. Keep the bundle, review and original predecessor observation in private directories outside Git. If using the archived lineage receipt, copy its original bytes and verify them against the retained digest first.

```sh
node ops/platform/p2-frontend-replacement-plan.mjs --plan \
  /absolute/private/bundle /absolute/private/replacement-review.json \
  REVIEWED_REPLACEMENT_REVIEW_SHA256 /absolute/private/frontend-lineage-observation.json
```

Record the review SHA-256 through independent operator custody. The review binds the exact candidate, frontend job and baseline file digests. Its predecessor entry binds the retained raw journal digest, direct target, Neon project/branch/endpoint, prior deployment and recovery reference. Its replacement entry binds the distinct Neon resource, reviewed database and migration login OIDs, effective administrator login OIDs and replacement recovery reference. The planner checks these bindings and the exact ordered migration chain against source. Its output records the reviewed selection for later host observation and grants no execution authority.

## Supervised empty-target check

Prepare a private settings document with version 1, the exact `staging-current` qualification profile, environment `staging`, the local planner inputs, `reviewedPlanFile` and `reviewedPlanSha256`, a private `results` directory, `knownHosts`, `sshKey` and `host` with `machineId`, `bundle` and `results`. The reviewed plan file contains the original output bytes of the offline planner. The host bundle contains the matching private candidate files. The migration image for that candidate must already be present by immutable digest. Resolve the reviewed replacement database credential through the private runtime handoff.

```sh
node ops/platform/p2-frontend-replacement-arm.mjs --verify-locked /absolute/private/arm-settings.json \
  --confirm staging/RELEASE_ID/replacement-arm/REVIEWED_PLAN_SHA256
```

The arm checks passing CI for the exact source before installing it on the selected host. The host holds the staging flock and observes the original PostgreSQL backend through the packaged image. The operator checks the empty catalog after that independent session disconnects and releases its own advisory locks before the final host receipt. Retain the matching local and host receipts. The eventual release must reacquire both locks and repeat the target checks before role preparation or SQL.

## Reviewed release sequence

1. Freeze both reviewed API `main` commits after required CI and refresh the frontend contract and scoped runtime pins. Qualify the exact frontend source on Linux. Prepare the immutable candidate and the exact full migration job and schema baseline for the selected replacement target. Review the complete 83-tag chain against the candidate. [Operator sequence](p2-staging-certification.md#prerequisites-and-operator-sequence).
2. Prepare one explicit host action under the single-operator policy. The action needs the reviewed selection and predecessor receipts, exact replacement target and credentials, producer inventory, provider and schedule closure, and the compatible frontend deployment configuration. Dardan starts the concrete action after reviewing its target, migrations and release ID. Target setup and candidate publication have separate approval steps. [Release policy](release-policy.md).
3. Hold the staging host flock and physical PostgreSQL advisory lock continuously through target and empty-state verification, role preparation, admission bootstrap, SQL, runtime readiness, frontend deployment, workload verification and promotion. Independently verify the original PostgreSQL backend and action nonce before permitting SQL. Prove the frontend runtime credential connects to the selected replacement role and database before binding it. Promote with both admission classes and unrelated schedules closed.
4. Retain the original attempt, committed SQL and failure receipts. After an interruption, reconcile actual lineage and any deployment or promotion effects under the reviewed recovery action. A fresh apply requires the original empty boundary. The owned bootstrap, same-session database continuation and packaged abort passed disposable PostgreSQL checks. Installed host execution, compatible promotion, interruption recovery and deployed certification remain open. [Owned write and abort evidence](baselines/2026-11-09-p2-replacement-write.json).

The replacement operator settings point to the original arm review, a private local configuration copy, the reviewed runtime plan, the writer coverage review and the private provider handoff. The planner binds both API jobs and the exact configuration hashes, and checks that the writer review covers the candidate source. Use its exact confirmation value for the separately reviewed operator start.

```sh
node ops/platform/p2-frontend-replacement-release.mjs --plan /absolute/private/replacement-settings.json
node ops/platform/p2-frontend-replacement-release.mjs --apply /absolute/private/replacement-settings.json --confirm EXACT_REVIEWED_CONFIRMATION
```

The apply entry requires passing CI for the exact source, the selected host and all three reviewed migration credentials through the existing private runtime handoff. The Node transport carries the original receipts into the supervisor and joins the replacement runtime, reviewed predecessor promotion and independent PostgreSQL closure. The supervisor returns a certification-readiness receipt after broker exit and fresh readback. Candidate CI, actual target selection, operator start and the replacement certification join are open. [Operator and terminal qualification](baselines/2026-11-09-p2-replacement-operator.json).

## Fresh admin initialization

After compatible deployment is verified, prepare a separate first-owner `interactive-browser` action with stage `identity`, an empty `requests` list, and `firstOwner` containing the reviewed `nonce` and `identitySha256`. Use a new nonzero 16-byte hexadecimal nonce. Compute the digest with `p2FirstOwnerIdentitySha256` from the normalized allowlisted owner email and exact Google subject in the private handoff. Keep both identity inputs private.

The profiled certification preview is `node ops/platform/p2-certification.mjs plan-profiled-current /absolute/private/settings.json`. The replacement continuation must supply a supported release receipt to that planner. After the release and admission prerequisites pass, Dardan starts the reviewed `apply-profiled-current` action with `--confirm staging/CERTIFICATION_ACTION_ID`.

Use the normal verified Google administrator sign-in in the scoped browser. The permitted routes cover sign-in, the Google callback and the dedicated protected first-owner route. The scoped callback binds the session to that window. The protected route materializes the reviewed owner, and the held database witness requires zero prior admin rows and exactly one fresh active owner row before closing the window. Use the observed UUID for authoring and the audited grant cases. Create the separate non-editor through the owner staff workflow and bind it through its own verified sign-in. [Approved first-owner setup](decisions/2026-11-06-isolated-p2-qualification-lane.md).

Use the [staging binding checklist](baselines/2026-11-07-p2q-f78-ci/README.md) for the exact admin origin and both Google clients. The metadata preflight proves names on the selected staging project. The reviewed first-owner window still needs actual callback and persisted owner evidence.

## Failure observation boundary

The owned abort observer matches the previously verified backend identity and rechecks the database and role OIDs before termination. PostgreSQL signals by PID and retains a short interval between backend validation and signaling. The host must authenticate the durable observation and retain uncertainty on a failed termination or readback. After the original backend is absent, the observer holds the migration lock while it reads the committed prefix. This receipt supplies no replay authority. [PostgreSQL signaling implementation](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/storage/ipc/signalfuncs.c#L94-L109).

The source-only host custody acknowledgement binds the original arm, exact catalog receipt bytes and a second physical observation. It grants no write or provider authority. The eventual release must independently verify the empty catalog and role boundary on the held session before the first write. If supervisor loss prevents verifying observer cleanup, retain the abort result and an uncertainty receipt. The installed action remains the read-only arm until the source-owned continuation verifies deployment and promotion under the same locks. [Custody and abort evidence](baselines/2026-11-09-p2-replacement-write.json).

After SQL, the packaged readback verifies the entire committed journal and the reviewed role, login and closed admission state on a second TLS session. Its receipt binds the original backend and both locks to the raw database and continuation receipts. The supervisor retains the readback from the pinned image and verifies the original custody before acknowledging it. The runtime intent binds both API jobs and the exact configuration. The continuation requires both locks through API readiness, checks closed-zero gateway admission and preserves the original frontend job and receipts. After broker loss, the guard closes the verified gateway and reconciles only the replacement runtime and labeled helpers. Its receipt distinguishes observed cleanup from unverified daemon completion. [Supervisor qualification](baselines/2026-11-09-p2-replacement-supervisor.json).
