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

Modes are `native-window`, `fault-before-upstream`, `fault-drop-after-ack`,
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
close and drain. Worker invocation is a separate action and is not implemented by
this package.

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
authentication/browser require literal nativeOFF, and native/fault require the
last positively observed source-selected toggle state. A provider change outside
that transition revokes the stage. Containment remains metadata-only even after
private-probe expiry. No SQL
executor, role creation, LOGIN reopening, build, promotion or runtime replacement
is exposed. The parent never claims a missing original frontend SQL terminal.

On loss, the independent guard reaps mutators before metadata-only native disable,
FE fence, actual mounted gateway fence, and runtime stop. Each failed observation
stays unknown and cannot skip later closure. If the guard itself is lost, the
surviving broker revokes registered children and waits for its one native-toggle
mutex before independent disable. Neither path reopens admission. Raw private
probe/capture credentials are outside common receipts and scrubbed by the source
cleanup paths. No cron secret is read by this parent.

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
Drop-after-ACK may retain exactly one source-proven typed effect and uncertainty1
for review, but cannot settle it, clear counters, authorize replacement or restart.
The separate known-ACK-loss settlement/recovery binder is OPEN. S14's real24-hour
read-only observation is outside all bounded certification locks. Actual Linux
Docker/SSH, normal browser auth/playback, native provider request evidence and
staging execution remain separate unqualified gates.

## Owned checks

Run parent source/protocol tests with Node24:

```
node --experimental-strip-types --test ops/platform/p2-certification.test.mjs ops/platform/p2-certification-request-evidence.test.mjs ops/platform/p2-certification-transport.test.mjs
PYTHONPATH=ops/platform/host python3 -m unittest p2_certification_parent_test
P2_CERTIFICATION_OWNED_TEST=true PG_BIN=/absolute/postgres16/bin node --experimental-strip-types ops/platform/test-p2-certification-local.mjs
```

The last fixture owns and removes a loopback TLS/SCRAM cluster, applies actual83
migrations, verifies actual initial and continuous scopes and refuses privilege/
marker/session/epoch faults. `OWNED_POSTGRES_MAJOR=18` requires an actual PG18
binary directory. Its receipt explicitly leaves hostDocker/browser/native false.
The transport fixture uses a real child pipe and POSIX flock, not a live host;
fixture-injected transports cannot mint authentication or suspension capabilities.
