# Lifecycle-only native scheduler qualification

`ops/platform/p2-lifecycle-native.mjs` and `ops/platform/host/p2_lifecycle_native.py` implement a bounded staging certification stage. They temporarily enable only the immutable definition `{path:'/api/cron/account-lifecycle',schedule:'* * * * *'}` on `prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM`, observe concrete native request/admission/receiver evidence, and finish with native scheduling disabled and both admission classes closed. They do not enable ordinary business crons, production, monitoring, features, provider ingress, application migrations, or a general ready profile. Accepted G1 receipts remain unchanged.

The stage uses the existing P1 project/deployment controls, including the supported project cron toggle and exact `project.crons` metadata. It never runs the P1 six-flags-off or closed bootstrap probe against the enabled P2 profile. Every full runtime boundary uses the authenticated `phase2` GET with all ten exact expected feature controls and the actual five-field immutable `writerAdmissionBinding`: `mode`, `targetSha256`, `producerSha256`, `sourceCommit`, `roleName`. The source-owned final workload receipt supplies `configurationRecordSha256`; current project environment values and the earlier bootstrap deployment are not substituted for final runtime configuration.

## Operator API

`prepareP2LifecycleNativePlan(candidate, input)` is offline and reads no credential. It requires a qualified staging P2 candidate, exact deployment ID/URL and configuration record digest, direct migration target and its digest, admission owner/producer names and actual OIDs, initial epoch, all ten boolean feature controls, a 60–180 second window, 1–180 second ledger observation budget, and explicit command witnesses `{commandId,accountVersion,action}`. Lifecycle and lifecycle recovery controls must be true. Its final disposition is explicitly `disabled-and-admission-closed`. The plan also verifies exact Git blob digests for the reviewed cron, actual admission runner/context/configuration, lifecycle worker/store/client, root opaque trace and runtime binding probe source. Changed or unavailable source refuses.

Read-only Git calls trust only the canonical selected source directory using per-command `-c safe.directory=<selected source>`. They use a closed environment, disable global/system configuration and replacement objects, and read blobs without external diff or text conversion. The owned fixture resolves its exact HEAD through the same bounded source selection. This supports the CI checkout/container ownership boundary without wildcard trust or persistent Git configuration changes; CI must mount the selected source's Git metadata read-only.

The plan-only executable is:

```sh
node ops/platform/p2-lifecycle-native.mjs --plan candidate.json native-settings.json
```

Apply is an explicit source-owned in-process call:

```js
await qualifyP2LifecycleNative({
  plan, client, directory, confirmation: `staging/${plan.actionId}`,
  verifyEnvironment, verifySession, withOwner,
  nativeControl: { observe, observeMetadata, setEnabled },
  observeNativeRequests,
});
```

The parent retains its existing native environment flock and physical frontend migration connection/advisory lock. The API takes no nested lock and requires no second human approval step. It independently checks authorized TLS, explicit host/port, actual current/session user, database/major, stable physical PID, actual held advisory lock, admission schema owner OID, and enabled producer/source/role OID. Ledger projections run as the dedicated admission owner; public command/delivery projections switch back to the migration session's own role within the same read-only snapshot. The owner gains no public business-table grants.

Use a separate existing canonical mode-0700, operator-owned directory outside Git. Source-owned exclusive atomic records retain the plan, runtime preflight, epoch transitions, toggle intents, actual ledger/delivery projections, operator observations and outcome. Runtime CRON/protection/API credentials remain only in the parent's existing private context. Neither executable reads CRON_SECRET, passes credentials in arguments, nor prints private provider/probe responses. No database URL is accepted by the native plan.

The host context is `{candidate,plan,configurationRecordSha256,privateProbeDirectory}` with the existing runtime-only `vercel.Client` and `frontend_probe.ProbeClient`. `observe(context,client,probe)` verifies actual project/deployment metadata and the protected P2 response; `observe_metadata(context,client)` reads only the exact native definition/deployment; `set_enabled(context,client,enabled,attempt,verify,probe)` performs one explicit toggle with retained intent/readback. Disable uses metadata only, so a receiver/probe outage or expired probe credential does not itself prevent removing temporary native capability. Node adapters map these functions to the three `nativeControl` methods. No log endpoint, provider queue API, request-ID response field, or queue lifetime is invented.

## Ordered operation and final state

1. Verify the exact current ready deployment, source/configuration/ten controls/immutable writer binding and the single disabled lifecycle definition. Read actual policy, producer and global active/uncertain counts. Selected command/version/action witnesses must exist with both receiver deliveries, including outstanding work.
2. Record and commit a recovery-only epoch barrier: new-work false, recovery true. Retain the actual post-barrier ledger/delivery snapshot and require no active/uncertain or already admitted operation in the new window epoch. At least one selected delivery must still be outstanding in this snapshot before enable. Ordinary new-work is not re-enabled as cleanup.
3. Retain the enable intent and request native enable once. Observe exact readback and hold the bounded window under both existing locks. The stage never directly invokes the lifecycle cron or runs `vercel crons run` as native evidence.
4. Request disable once if still enabled and positively read back the exact disabled definition. Disable is distinct containment, never a retry of an uncertain enable. A failed/lost acknowledgment is preserved explicitly; no mutation is automatically replayed.
5. Record and commit closure of **both** new-work and recovery, advancing the policy epoch. Already admitted old-window work can finish. Observe actual ledger active/uncertain counts within the budget; do not settle/reconcile uncertain entries. Future requests on the verified immutable source must pass the same admission gate and cannot create new effects after closure.
6. Validate finite provider-observed request witnesses, join their actual trace UUIDs to durable operations, and verify actual command/delivery persistence and per-receiver account-version ordering. Every new operation in the certification epoch must have the matching native request witness, correct source/producer/role, recovery kind, completed state and no operator reconciliation override. At least one delivery outstanding in the retained post-barrier snapshot must become acknowledged with a strictly greater attempt count, and all selected receiver receipts must be acknowledged without leases. Work completed during the barrier supplies no native-window progress.
7. After operator inspection, re-read project/runtime and the actual closed policy/ledger/receipts, followed by a final exact runtime boundary. A concurrent epoch/profile/source/native-enable change invalidates the final fence. `nativeEnabled: false` requires this final current boundary; a failed boundary returns null for that field.

`P2_LIFECYCLE_NATIVE_QUALIFIED_FENCED` requires all these checks. The result includes the actual final epoch/flags/counts, finite correlation and ordered-persistence predicates, and known/unknown enable/disable outcomes. `providerQueuedInvocations` and `providerActiveInvocations` remain null; `providerCancellationVerified` remains false. The safety proof is actual source admission fencing plus zero tracked active/uncertain operations, not an exhaustive cancellation claim. The result is suitable for a separately composed **closed certification terminal profile**, not the driver's ordinary new-work/recovery-ready completion. It never automatically reopens or enables anything.

## Native request observations

The official documentation describes cron logs as function invocations accessible from the cron's **View Logs** page and a path filter. It does not establish an exhaustive queued/running invocation API. The accepted C07 receipt also records a real native completion 17.875 seconds after disable, beyond its initial 16-second wait. Neither a fixed drain delay nor a later quiet interval is used here as universal cancellation proof.

`observeNativeRequests(plan,windowEpoch)` supplies source-owned operator observations of the actual provider request details. This is explicitly an operator observation schema, **not** an asserted Vercel API wire format. Each record has:

- `version:1`, `kind:'vercel-native-request-details'`, `reviewerGithubUserId:'8996309'`;
- exact project/deployment/path, `method:'GET'`, the observed `providerRequestId`, and `providerRequestTypeFilter:'cron'`;
- actual UTC `startedAt`/`completedAt`, `httpStatus`, `logScope:'this-provider-request-details'`;
- the actual bounded `admittedLogLine` visible in **that request's own** log/details envelope.

The app emits `{version:1,status:'P2_LIFECYCLE_CRON_ADMITTED',environment:'staging',projectId,operationId,producerSha256,sourceCommit,epoch,kind:'recovery',targetSha256}` only after real admission in the exact staging lifecycle certification mode. The UUID is generated internally by the runner. It is never derived from request headers. The operator must observe the provider's native classification and the line in the same request details; an aggregate log search, user agent, manually triggered request, copied line or asserted completeness boolean is insufficient.

The module checks every field and joins `operationId` to the actual SQL row. It joins against the **admitted window epoch**, not the later closed policy epoch. Distinct native requests/operations remain distinct even when receiver idempotency makes a later invocation empty. A provider-observed 503 request with no admitted line can be retained as an uncorrelated finite observation; absence of that line alone is not called admission-denial proof. The actual closed policy and source gate supply the fence. Missing request-scoped classification/log evidence leaves the stage OPEN.

## Interruption and containment

An existing intent or outcome blocks another apply. SIGKILL cannot execute a `finally` block; it can leave native scheduling and recovery admission enabled. The process-death test retains this fact, not a successful cleanup claim. Later record loss still attempts mandatory disable and closure under the already-retained plan, but lost locks, storage or transport can prevent verification. Such states remain OPEN and must not be reported as bounded cancellation or release acceptance.

`observeP2LifecycleNativeState(input)` performs read-only current metadata/policy/ledger observation. `containP2LifecycleNative({...input,originalDirectory,directory,expectedEpoch})` is a fresh explicit containment action under actual reacquired locks, using the retained original runtime preflight/plan and an exact observed epoch within its reviewed transition range. It may only disable and close; it never resumes the window, enables, reopens, settles operations, or accepts P2. It preserves original receipts and returns `P2_LIFECYCLE_NATIVE_CONTAINMENT_REQUIRES_REVIEW`. This containment can be composed under the existing certification authorization; it is not another human approval ceremony or an automatic replay.

Containment treats the disable readback before drain as provisional. After drain it rechecks the actual held environment/session locks and exact project/deployment/source/URL/schedule/disabled metadata, then retains `p2-native-containment-final-boundary.json`. Only that successful final readback can report `nativeEnabled: false` and a verified fence. Re-enable, source/definition drift, unavailable metadata or lost locks leave the native state null and the fence false. Containment does not retry a concurrent enable.

## Executed qualification and limits

The baseline `baselines/2026-11-05-p2-native-lifecycle/` retains 12 passing protocol/refusal tests, seven actual owned HTTPS control/probe tests, and an actual PostgreSQL 16 rehearsal with all 83 migrations and eight executed stage checks. The rehearsal uses the actual exported lifecycle GET, admission runner, store and root structured trace, plus actual HTTPS receiver requests with service JWT/idempotency/ordered command checks. Nonempty and empty requests join two completed durable operations; a modeled queued request executes after disable and closure, returns 503 and creates no trace, new operation or receiver effect. The SIGKILL protocol test uses a model backend and a real killed process; it does not claim live provider/process cancellation.

The provider scheduler/native classification is explicitly modeled in owned tests. **Actual Vercel-native request details and final managed-staging/PG18 same-action execution remain live gates.** This package does not claim P2-11/P2-12 live completion, universal queue cancellation, production qualification, or whole-release acceptance. The first sandbox HTTPS attempt was refused before local listeners; the approved owned loopback rerun and the initial/final PostgreSQL source receipts are retained separately.

The follow-up `baselines/2026-11-06-p2-native-lifecycle-fences/` retains the stale-snapshot regression failures and fixes. Sixteen protocol tests pass, including eight post-drain metadata/lock scenarios; seven owned HTTPS adapter tests pass. The final owned PostgreSQL 16 rehearsal applies all 83 migrations and executes nine checks, including a second-connection delivery acknowledgement inside the barrier UPDATE that must refuse before native enable. These remain owned source tests with modeled provider classification.

Reproduce with Node 24 and PostgreSQL 16:

```sh
node --test ops/platform/p2-lifecycle-native.test.mjs
(cd ops/platform/host && python3 -m unittest p2_lifecycle_native_test.py)
P2_NATIVE_OWNED_TEST=true PG_BIN=/path/to/postgresql16/bin \
  node ops/platform/test-p2-lifecycle-native-local.mjs
# CI can explicitly select the owned PostgreSQL 18 binary:
P2_NATIVE_OWNED_TEST=true OWNED_POSTGRES_MAJOR=18 PG_BIN=/path/to/postgresql18/bin \
  node ops/platform/test-p2-lifecycle-native-local.mjs
```

`OWNED_POSTGRES_MAJOR` accepts only `16` (default) or `18`. The fixture verifies the actual binary version before opening a listener, binds the target and child verifier to that major, and records `postgresMajor`. It accepts no external database URL. Local PostgreSQL 18 execution is not claimed by the PostgreSQL 16 record; the root-owned CI run supplies that separate check.

Primary references: [managing cron jobs](https://vercel.com/docs/schedules/cron-jobs/manage-cron-jobs), [Vercel logs CLI](https://vercel.com/docs/cli/logs), [manual cron command](https://vercel.com/docs/cli/crons), and [project metadata reference](https://vercel.com/docs/rest-api/projects/update-an-existing-project). The component uses accepted existing native toggle code and actual metadata; documentation links do not substitute for live readbacks or request evidence.
