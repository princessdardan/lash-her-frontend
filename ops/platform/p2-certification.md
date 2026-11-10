# Fixed bounded P2 certification parent

This source package operates an already deployed P2 staging candidate. It does
not authorize a live start. Dardan must review the exact candidate, source,
configuration, action, state/epoch, retained READY receipts and private inputs
before `apply --confirm staging/<certificationActionId>`.

Normal browser sign-in uses the approved canonical origin
`https://staging.lashher.com`, separately from immutable deployment provenance.
The protected `phase2-auth-origins` probe mode extends the existing phase2
workload envelope with only `authenticationOrigins`: actual validated customer
origin, effective admin origin, null admin redirect proxy, and the source's
disabled customer redirect proxy. Customer authentication must be configured and
the effective `AUTH_URL` or `NEXTAUTH_URL` must explicitly use the canonical
origin with `/` or `/api/auth`; a configured admin redirect proxy refuses this
certification mode. Bearer/challenge, staging project/source, private/no-store,
and the existing one-hour probe lifetime remain mandatory. Existing probe modes
keep their response shapes. This observes configuration; real provider/browser
sign-in remains necessary, together with a fresh exact alias/deployment join.

`settings.host.configuration` must select the actual mounted runtime snapshot,
such as the retained release or recovery snapshot's `configuration` directory.
The local `settings.configuration` may remain the original byte-identical private
input. The host checks actual gateway mounts and admission state; supplying the
original remote input directory instead of its mounted snapshot is a refusal.

`node --experimental-strip-types ops/platform/p2-certification.mjs plan SETTINGS`
is read only and does not resolve credentials or contact providers. `apply`
requires Node24, exact committed operator source with passing source CI, pinned
SSH known-host/key files, an installed source closure, and the fixed remote
`p2_certification_parent.py --supervisor` entry. There is no local Docker/host
Node fallback, dynamic module path or JSON-selected command.

## Reviewed selection

The settings extend the existing P2 release settings (`bundle`, `inventory`,
`configuration`, `host`, `results`, `providerContext`, `knownHosts`, `sshKey`) with
`operatorSourceCommit`, `frontendReceipts`, and `certification`. The latter binds
version1/staging, a distinct certificationActionId, one fixed mode, startState
`qualified-ready` or `already-closed`, exact initialEpoch, raw candidate SHA,
normalized inventory SHA, original configuration record digest, actual runtime
inventory/process/gateway configuration hashes, installed operator source-closure
SHA, and the six exact READY receipt hashes. Its `native` section is the existing
fixed native plan input. The original releaseId and application source remain
unchanged. No original terminal receipt is synthesized.

`frontendReceipts` is the reviewed selected build/promotion tree, including the
source-qualified forward build when applicable. The six files are
frontend-build-started.json, frontend-build-created.json,
frontend-build-outcome.json, frontend-workload-outcome.json,
frontend-promotion-started.json, and frontend-promotion-outcome.json. Each raw hash
and project/release/app-source/deployment binding is checked repeatedly; the
workload's ten feature flags, writer binding and P2 manifest must match exactly.

Modes are `direct-worker`, `native-window`, `fault-before-upstream`, `fault-drop-after-ack`, `known-ack-recovery`,
`contain-native`, and the source-composed authentication/browser pair. Native
windows retain the existing60–180-second bound and drain budget. Fault cases use
the fixed driver stage, exact selected actual command and canonical command hash.
Containment disables through metadata-only observation even if the original
private workload probe has expired. Healthy activation requires an actual
unexpired workload probe, with the existing one-hour maximum unchanged.

## Authentication and browser actions

A browser settings selection has `certification.mode=browser-pending`,
`startState=already-closed`, and a separately reviewed `authPreparation` object
with certificationActionId/startState/initialEpoch. Browser initialEpoch must be
exactly authentication initialEpoch+2. `browser.input` is the fixed suspension
plan input and `browser.persistenceReviewed` is the existing source/three-target/
configuration/runtime persistence selection. Its three private resource UUIDs
are bound only by resourceBindingSha256 in the public plan.

One actual fixed IPC child is launched and initialized without browser/HTTP.
The authentication action acquires both guards, checks current source/config/
three databases/ten processes/nativeOFF, arms, moves FE and gateway to
newWork=true/recovery=false, then issues the opaque authentication-stage handle.
Only that handle permits the child to open normal Google/Resend sign-in pages.
The action refuses after300 seconds; there is no extension or fabricated session.
It closes both gates and proves active/uncertain0 before retaining a successful
terminal. The same child and in-memory capability survive into the separately
locked browser action. They cannot be serialized or reconstructed from JSON.

The browser action has its existing840-second child budget inside the900-second
parent refusal bound. It rechecks actual customer/owner sessions and fresh Google
through the same child, opens only newWork, records normal600-second playback,
captures the controlled pre-suspension JWT privately, and permits the normal
owner UI to create the command. No command UUID is preallocated. Source readers
join actual202/header ID, natural user exp+30 denial, actual playback expiry and
player removal, then the fixed read-only pending query proves both deliveries
remain pending/attempts0/no leases/no ACKs and sessions revoked. Finally both gates
close and drain. Worker invocation uses the separately selected direct action
below; browser success does not invoke it automatically.

## Direct worker action

`certification.mode=direct-worker` requires `startState=already-closed`, the same
installed operator/application source, and exactly one actual retained suspension
command. `worker.suspensionInput` re-derives the original source browser plan;
`worker.persistenceReviewed` selects its existing exact three-target/configuration
reader. `certification.worker.input` is the fixed eight-field worker selection:
version, distinct actionId equal to certificationActionId, commandIndex0,
pendingRecordSha256, canonicalCommandSha256, gatewayProcessSha256,
gatewayConfigurationSha256, and denialProgramSha256. The source-owned worker
constructor and host retained reader check the original browser/pending/natural
receipts. Caller JSON cannot assert their completion.

After current three-DB/ten-runtime verification and ARM, the fixed parent resolves
only `FRONTEND_STAGING_CRON_SECRET` from its apply process and the existing private
`providerContext.frontendRuntimeDatabaseUrl`. Neither value is read in plan mode,
placed in argv/common receipts, or hashed as evidence. They pass through private
SSH stdin to fixed source operations. A bad-key401 and valid-key admission503
with no operation UUID are required while recovery is closed. The actual held
frontend client also proves exactly the selected two pending deliveries,
attempts0/no leases/no ACKs and no unrelated eligible export/scrub work.

Only then FE and gateway recovery open at E+1, newWork remains false and native
remains OFF. One normal authenticated GET must return the actual admitted
x-request-id; the source ledger joins that exact completed recovery operation,
source/producer/role/epoch and both ACKs. The request is never retried after an
unknown response. Both gates close at E+2 before the source three-DB canonical
receipt and receiver denial reads. Course proves the actual protected HTTP403;
Community proves the deployed private account-access guard, with httpStatus null.
No Community HTTP endpoint is invented. The contained terminal binds both the
exact local source artifact bytes and retained host machine artifact, followed
by a fresh closed/zero/nativeOFF readback. It records directWorkerSourceJoined
without qualifying native invocation or completing persistence/S12 authority.

## Deliberate known ACK-loss qualification and replacement

`known-ack-recovery` is an upfront reviewed case for one actual retained suspend
command with both deliveries still pending/attempts0/no leases/no ACKs, no later
version and no unrelated pending/export/scrub work. Operator and application
source must match. Its existing `fault` selection binds commandIndex0, one target
receiver, stageId and canonical command SHA. `knownAckRecovery` has exactly
version1, a distinct recoveryActionId, configurationInputDirectory and the two
reviewed receiverTargets (host, port, database, user, serverMajor, runtime roleOid).
The public plan derives an immutable replacement intent binding original raw
candidate/source/contracts/configuration/target, full operator closure, original
ten-runtime inventory, gateway process, native plan and receiver targets. That
intent permits one ordered same-candidate runtime replacement under the same
hostFD and actual frontend physical session. Every other mode retains its
existing runtime-replacement refusal.

configurationInputDirectory selects a canonical root-owned private staging input.
The actual mounted snapshot remains the observed old-process configuration. The
current P2 snapshot producer copies all19 selected configuration bytes unchanged;
its TLS modes/ownership and added compose/admission directory are the differences.
Before ARM/fault, the source validates root ownership/private/runtime target
scope and exact input-to-mounted byte equality. A prior restoration must select
its retained root-owned configuration-input output when applicable. This mode
has no historical raw-input normalizer or caller equivalence assertion and never
chowns a mounted65532 snapshot into an input. New snapshot bytes remain identical.

The host issues its recorder before fault arm, retaining actual FEzero and the
same gateway0 process with the exact two untouched deliveries. It arms one fixed
target lease (maxMatches1), advances the source epoch and temporarily enables the
existing native schedule. Normal provider invocations perform the work. The
bounded60–180-second window must observe exactly one uncertain503 operation from
the typed dropped ACK and one later completed200 replay, both ACKs and actual
three-DB canonical receipt/user/version equality. Selected attempts must be2 and
the other receiver1. Any third request, unrelated work/effect/producer/command/
version/process/uncertainty refuses. Existing approved operator request-details
bytes must join those exact two operation IDs while the window is still active;
no API completeness or native provenance is inferred from counters alone.

The source disarms, disables native, closes both gates and requires zero active
work. It prepares a retained specific-operation settlement only after the domain
and explicit request proof. The owner reconciles only that actual uncertain FE
UUID with the retained evidence SHA, then fresh FEglobal0 and oldgateway1 are
required. Original0/1 receipts remain immutable. The private process-local
authorization is reserved atomically before verification I/O, consumed once and
poisoned on verification failure. Serialized/copied/cross-scope authority refuses.

The exact KnownAckLossBoundary and dedicated KnownAckRecoveryScope delegate all
children and revocation to the original physical/flock scope. The dedicated
runtime constructor initializes the complete common runtime field set after
authority validation and reuses its actual restore and stage methods. Ordinary
scope/runtime constructors and their zero gate remain unchanged. Both current
API checks precede destructive work, and fresh current checks follow restoration.
The common internal runtime-readiness receipt is retained as provenance; the
typed result is P2_KNOWN_ACK_RUNTIME_REPLACED_CLOSED with ordinaryClosedZeroGate
false and the old uncertainty transcript preserved.

The source fixes five ordered stages: both APIs; both private TLS proxies;
snapshot/community-worker/media/export-cleanup workers; publisher; gateway last.
Each stage has a120-second deadline within the existing900-second parent limit.
Every unaffected old/new service retains its exact image, private environment,
readonly mounts and process identity. Only the currently selected stage may be
temporarily unavailable. Actual environment values are compared privately and
are never receipt values or credential hashes. Fresh metadata and FE nonce/
locks/global0 remain mandatory. Only the literal API, TLS and gateway stages can
temporarily use immutable original workload/config/writer proof plus fresh exact
deployment/project/source/nativeOFF metadata. The unchanged original private
probe must remain unexpired. Full protected proof returns immediately after
each such stage; worker/publisher stages keep full proof continuously. A failed
probe never selects a fallback branch.

Gateway-last uses the existing source capture_before_stop and retain_ordered_stop
functions, preserving old1, exact source-module hashes and latest lineage before
the one replacement. Before returning to the inherited Compose recreation it
atomically persists and rereads the source `replacement-in-progress` lineage,
then exclusively retains `known-ack-gateway-replacement-started.json`. This binds
the installed helper/operator closure, action/candidate, authorization, original
stop hashes/process/binding, original stopped pointer and pending pointer.
Write, acknowledgement, existence or readback ambiguity refuses before recreation;
the source never reconstructs a marker or silently retries it. Pending pointer,
original stop receipts and marker bytes remain pinned through the gateway stage.
Only a fresh exact different new process with source/config/mount/health and
closed0 proof can publish the new `running-observed` lineage. The outcome binds
the raw marker SHA as `gatewayReplacementStartedSha256`. Pending/no new readback
is unknown; retained old1 cannot authorize another recreation. Older B gateway
intents without this source-qualified frontier remain ineligible for automatic
or inferred restoration. A later deliberate C action is separately qualified.
The new gateway must have a different actual container ID,
closed gates and zero counters. All ten current process checks then rebind to
fresh observed identities, followed by full protected readiness and fresh current
three-target/physical proofs. The terminal remains closed with native disabled;
later admission restoration requires its separate reviewed action. Failure
retains unknowns and invokes existing independent containment. This case cannot
be attached retroactively to an unplanned failure or a stopped/unknown process.

Backend workers remain running throughout the fault/replay window. Their private
paths bypass gateway admission, so FE queue eligibility is insufficient. Before
fault arm, continuously, and before consuming replacement authority, fixed
read-only observers require no unrelated backend work across the entire remaining
900-second parent horizon. They always use the same selected runtime images and
the already validated root configuration input's runtime credential, with verified
TLS, exact role/OID/database/major and registered finite helper containers. They
do not depend on the API containers remaining available during replacement.

The fixed Course projection requires an existing publisher singleton; no pending
outbox or lease; no requested/building/expired or horizon-expiring snapshot; no
media lease or managed undeleted media due within the horizon; no horizon-expiring
lifecycle export; and no publisher retention candidates. The retention boundary
is the existing180-day source policy. Community requires no pending/leased repair,
requested/running reconciliation, lease or horizon-expiring lifecycle export.
Its actual latest snapshot-backed reconciliation request and latest retention
audit must defer both fixed24-hour source schedules beyond the same horizon.
Missing schedule/control evidence refuses. Poll/configuration values do not
replace actual queue/timestamp observations.

Complete ordered safe projections of queues, controls, leases, terminal outcomes,
stream/snapshot rows, Community inbox/tombstones/projections and reconciliation
staging rows are digested privately. Each table is bounded at1000 rows; observing
the1001st row refuses completeness. Every subsequent projection must equal the
retained baseline, including a completed transient effect. Only the expected
selected lifecycle state/command receipt writes are outside these unrelated-work
projections; those retain their separate exact command/version/canonical proof.
No raw body, export data, token, provider URL or runtime credential is emitted.

These conservative prerequisites can make this case unavailable: managed Course
media is normally reconciled every60 seconds while the reviewed profile enables
the media worker. Eligible media, missing receipts or other work must refuse
before the fault. This action does not pause workers, clean up assets, invent
terminal receipts or alter retention to obtain eligibility. Actual source-owned
preflight/certification/ordering and G2 remain OPEN until their real prerequisites
and execution are qualified.

## Physical scope and containment

The Node process holds the actual verified-TLS FE connection, migration advisory
lock and fresh random advisory marker throughout each bounded action. A separate
host observer verifies backend PID/start time, both locks, complete current83
lineage/schema, prepared role OIDs/exact existing role policy, retiredNOLOGIN and
sessions0, admission routine definitions/producers, scoped unresolved operations,
selected command/deliveries/order, and exact epoch/state transitions. It forces
pg_catalog,public at connection startup. The observer uses the exact migration
image and a cached immutable source companion, not host Node.

The inherited host flock and independent source-selected supervisor remain live.
Before arming and continuously, the host joins both API read-only/current proofs
through each exact image's mandatory verifyOperatorRoles export, ten existing
same-image/process/mount inventories, actual gateway admission inode/counters,
source/config hashes, and full protected frontend features/writer binding.
Healthy readbacks are serialized with the source-owned native-toggle mutex;
authentication/browser/direct-worker require literal nativeOFF, and native/fault require the
last positively observed source-selected toggle state. A provider change outside
that transition revokes the stage. Containment remains metadata-only even after
private-probe expiry. No SQL
executor, role creation, LOGIN reopening, build or promotion is exposed. Runtime
replacement is restricted to the explicit typed known-ACK case above. The parent
never claims a missing original frontend SQL terminal.

On loss, the independent guard reaps mutators before metadata-only native disable,
FE fence, actual mounted gateway fence, and runtime stop. Each failed observation
stays unknown and cannot skip later closure. If the guard itself is lost, the
surviving broker revokes registered children and waits for its one native-toggle
mutex before independent disable. Neither path reopens admission. Raw private
probe/capture credentials are outside common receipts and scrubbed by the source
cleanup paths. The cron secret is read only by the selected direct-worker apply
path; the existing probe helper remains unchanged and never reads it.

## Native request evidence and limits

Only the approved explicit operator-recorded provider request-details contract is
implemented. `certification.requestEvidence` names kind
`operator-recorded-request-details` and an absolute private file outside the
checkout. The finite envelope binds reviewer8996309, certificationActionId,
nativePlanSha256, exact windowEpoch, recordedAt and observations. Observations
are the existing source-owned request-details schema. The validated original
bytes and explicit provenance are retained once. Automatic provider API evidence,
queue completeness, cancellation, caller completion booleans and inferred
User-Agent classification are never substituted. Missing evidence cannot qualify
native invocation.

The contained terminal keeps `persistenceAuthorityJoined=false`,
`deployedCertificationComplete=false`, and `wholeReleaseAccepted=false`.
Ordinary drop-after-ACK may retain exactly one source-proven typed effect and uncertainty1
for review, but cannot settle it, clear counters, authorize replacement or restart.
The explicit known-ACK path has source-preparation tests; its actual host/provider
qualification remains OPEN. S14's real24-hour
read-only observation is outside all bounded certification locks. Actual Linux
Docker/SSH, normal browser auth/playback, native provider request evidence and
staging execution remain separate unqualified gates.

## Owned checks

Run parent source/protocol tests with Node24:

```
node --experimental-strip-types --test ops/platform/p2-certification.test.mjs ops/platform/p2-certification-request-evidence.test.mjs ops/platform/p2-certification-transport.test.mjs ops/platform/p2-lifecycle-worker-evidence.test.mjs
PYTHONPATH=ops/platform/host python3 -m unittest p2_certification_parent_test p2_lifecycle_worker_evidence_test
P2_CERTIFICATION_OWNED_TEST=true PG_BIN=/absolute/postgres16/bin node --experimental-strip-types ops/platform/test-p2-certification-local.mjs
```

The last fixture owns and removes a loopback TLS/SCRAM cluster, applies actual83
migrations, verifies actual initial and continuous scopes and refuses privilege/
marker/session/epoch faults. `OWNED_POSTGRES_MAJOR=18` requires an actual PG18
binary directory. Its receipt explicitly leaves hostDocker/browser/native false.
The transport fixture uses a real child pipe and POSIX flock, not a live host;
fixture-injected transports cannot mint authentication, suspension or worker
capabilities. The direct-mode database regression checks primary and independent
observers at E+1/E+2, retains the original E+1 operation, refuses later epochs and
uncertainty, and verifies the migration journal is unchanged. Its synthetic
catalog row tests the parent window; the separate worker fixture proves the
actual route/dispatcher/three-DB path.

## Canonical-origin parent capability binding

The fixed parent calls the corrected canonical helper after current three-DB/
ten-runtime checks and before external ARM, continuously in authentication and
browser windows, and freshly before either authentication or suspension stage
capability is issued. Provider calls use the existing LockedClient and the
four-argument protected HTTPS probe uses LockedProbe, both retaining the actual
source/physical-scope verifier. A missing or drifted alias/source/deployment/
origin/proxy/profile/writer observation refuses the action before pages open or
revokes the active stage. Containment remains metadata-only.

Source-owned exclusive files p2-canonical-browser-arm.json,
p2-canonical-browser-authentication.json, p2-canonical-browser-suspension.json and
p2-canonical-browser-terminal.json retain the actual observations. The fresh
capability response carries the observation and its canonical SHA; the fixed
Node validator checks both before a live-channel WeakMap capability is issued.
The final contained receipt binds the terminal observation digest. JSON alone
cannot issue either capability. No private probe value/expiry is regenerated.
