# Bounded staging transport faults

This component injects one transport outcome for one existing reviewed lifecycle
command. It creates no command, account or provider event. It cannot stop/restart
containers, run caller SQL/commands, change provider keys, clear uncertainty or
reopen admission. The gateway has no activation endpoint/header/query/config or
environment-variable knob. Actual activation requires the reviewed source parent
with the FE physical database session and the actual canonical Linux host flock.

## Gateway module

`ops/gateway/p2-certification-fault.mjs` is enabled only for the exact dedicated
staging project/team/public API host, business staging, and the existing bound
`/admission/state.json`. It reads only fixed
`/admission/p2-certification-fault.json`, root:65532 mode 0640, regular/O_NOFOLLOW,
at most 8192 bytes. The existing gateway user is nonroot 65532; the file contains
opaque IDs/hashes and fixed metadata, no key/token/signature/raw request body.
The admission directory is already mounted read-only into the gateway.

A closed lease binds release/candidate/configuration, exact gateway image and
Linux process start identity, source witness hash, one record/receiver, a fixed
mode, `maxMatches:1`, and a window no longer than 120 seconds. It reserves its
one-match fuse synchronously before upstream I/O. A failed upstream response does
not rearm it. Process binding prevents restart reuse; a latched monotonic deadline
prevents clock rollback from extending a seen lease. Removal cancels an already
reserved later response drop. Missing, expired, malformed or unmatched leases
leave ordinary routing unchanged.

The root-owned wiring is after existing route/workload/application/admission
checks and bounded body collection. `beforeUpstream` can send the existing 503
`upstream_unavailable` response without issuing an upstream request.
`afterUpstream` can destroy the downstream socket only after the complete bounded
typed upstream 200, before ANY response status/header/body reaches the caller.
It never changes a request body. Existing gateway uncertainty accounting remains
active: an ACK-loss drop produces `uncertain.recovery=1`. That evidence must not
be ignored or cleared by this component.

The production constructor calls `createP2CertificationFault(config)` directly.
The existing server's source-only test factory seam permits owned reader/path
projections for HTTPS tests; no runtime caller can supply it.

## FE-bound source stage

`prepareP2LifecycleTransportFaultPlan(actualNativePlan,input)` selects one command
index in the reviewed native plan and its expected canonical hash. Its public
plan contains hashes and fixed metadata, no raw subject/command/body. The actual
native plan and selected command stay in a process-local registry. A serialized
plan cannot execute; an attempted plan cannot execute a second time.

`sourceCommit` remains the immutable frontend application source from the native
plan/candidate. Required `operatorSourceCommit` separately identifies the installed
supplemental operator tree and its complete source-closure hash. They may differ;
the runtime gateway module bytes must still match that operator tree. No candidate
source is relabeled to accommodate newer operator code.

`runP2LifecycleTransportFault` accepts only source dependencies:

```text
plan, client, withOwner, verifyEnvironment, verifySession,
hostStage, nativeControl, exercise, containFrontend,
directory, confirmation
```

The real Client must retain verified TLS, the same backend PID, exact migration
identity/database/major and the FE physical migration advisory lock. The stage
calls the native component's branded ledger observer, which checks actual
admission owner/OID/producer. Before arm it requires FE new-work closed, recovery
open, global active/uncertain zero; exact native metadata off; exact gateway
identity/config/source/process with both categories drained and only recovery
open; and exactly one globally pending eligible delivery for the selected command
and receiver, with the other receiver already acknowledged. It SELECTs the actual
immutable frontend command, validates all fields against its row/native witness,
and requires its canonical digest to match the plan. It accepts no caller body.

The parent invokes the actual worker through `exercise`. The stage requires one
closed source-generated gateway effect plus a real increase in the selected FE
delivery attempt count. Native request/trace correlation remains separate and
`nativeInvocationQualified:false` stays explicit here. Callback functions exist
only in reviewed source; JSON supplies none.

The host implementation is `P2CertificationFaultStage` in
`host/p2_certification_fault.py`. Construction requires an actual `P2ReleaseScope`
with the canonical inherited FD, selected release/jobs and live FE observer.
It calls that source-selected scope's `require_frontend` against the selected FE
job, so the base or current-only subclass must validate its exact receipt. The
Node plan's FE admission target hash is recomputed from that SAME host job and
compared explicitly. A generic scope with an arbitrary receipt is insufficient.
It verifies both raw candidate-file and canonical candidate-object hashes (these
are different identities), current private configuration, complete installed
operator source manifest, exact ten-service inventory, gateway module bytes,
process/config identity and the actual mounted admission directory's device/inode.
Every ordinary method continues those checks, including gateway security/mount
readback at each verification boundary. Publishing uses a fully written,
fsynced temporary file and an exclusive atomic link; original intents/receipts
are never overwritten. Root/group ownership is applied before publication.

Source host methods are `verify`, `observe`, `arm`, `effects`, `disarm`,
`close_gateway`, `close`. The Node parent's fixed adapter maps those methods;
there is no host activation CLI. Raw Docker logs are never retained/returned:
`effects` accepts only the finite exact component/stage/lease/process/record-bound
receipt and rejects extra fields. The cached mounted-directory FD allows removal
and gateway fencing after the original pathname/input/FE backend becomes
unavailable. Failure to obtain actual gateway readback returns null; persisted
file closure alone is not claimed as verified live closure.

Cleanup always awaits fault removal, gateway closure, the source parent's actual
frontend/native containment, native metadata readback and independent FE ledger
readback, including preflight/unknown-arm/later-receipt failures. It never releases
the parent's environment/database locks. `containFrontend` must compose the
reviewed native containment and appropriate fail-closed parent primitives, not
return a caller assertion. If anything remains active/uncertain, disabled native
state or closure is unavailable, the terminal is
`P2_LIFECYCLE_TRANSPORT_FAULT_REQUIRES_REVIEW`. No automatic reconciliation occurs.
The parent must await this result before releasing its locks.

After the final FE ledger read, the stage rereads the exact current gateway
process/source/mount/lease/admission/counters, then reads native metadata last.
Earlier successful close/off responses cannot satisfy the terminal. A reopening,
restart, lease reappearance or failed terminal read produces current false/unknown
fields and a requires-review result; stale closure/off facts are discarded.

Preflight and terminal also require the existing authenticated full frontend
probe: exact configuration-record hash, ten feature controls and writer-admission
binding. A fresh metadata-only GET follows the full probe and supplies the last
native enabled observation. Metadata-only disable facts remain reportable when
the protected probe is unavailable, but that fallback never qualifies the stage.

## Deliberate recovery after ACK loss

Retain the old exact gateway process/counter receipt, the one injected effect,
canonical command digest and receiver receipts. Prove zero active and exactly one
new gateway uncertainty from an initial zero under the same process; the known
drop contributes that one monotonic uncertainty. Any additional unexplained
counter/operation remains OPEN. Independently prove the receiver accepted the
canonical command once, ordinary exact retry produced the expected receipt, and
both frontend deliveries acknowledged it. Reconcile only the exact admitted FE
operation through a separately deliberate evidence-backed source action while
gates are closed, then prove FE global active/uncertain zero. This component
performs no such reconciliation.

The existing P2 current-only recovery runtime is a suitable replacement primitive
after those conditions: distinct reviewed recovery action, immutable original
candidate/jobs/images/receipts, fresh FE physical/current proof, both API
read-only current proofs, fixed ten-service replacement and normal ordered
restoration. Replacement naturally creates a new gateway counter process; it
must bind the old fault/settlement receipts and new runtime receipt. There is no
generic counter-reset API, automatic restart or permission to use recovery to
erase an unexplained uncertain outcome. The certification parent's explicit
business-fault authorization join is still required before this boundary can run.

## Closed Mux profile

The gateway module also supports only `mux-managed-track-ready-v1`: one prebound
managed attempt/lesson/environment/generation/parent asset and exact marker, with
`video.asset.track.ready`. New track/event IDs are latched from incoming bytes only
after an exact Course managed 200 response matching the attempt and lesson.
The source parent must join actual before/after SELECT proof that the same row is
managed, in that environment/generation with those provider IDs. Pinned Course
legacy fallback explicitly excludes managed rows; with that join the matching
200 proves the verified managed path. A generic 200 or unmatched 204 is insufficient.

Receipts retain only event/type/environment/object/managed metadata, original
RFC3339 timestamp precision, monotonic observation time and exact response
metadata. Raw body/signature/key is absent. A genuine provider retry with the
same event ID arriving after a later verified event without regressing current
state satisfies the intended retry-order scenario. It does not claim first
processing of the older event occurred out of order. Equal provider timestamps
do not establish order. Module unit sequences are synthetic, not Mux evidence.
The current lifecycle host issuer does NOT activate Mux leases; the fixed managed
row witness/parent stage remains a separate integration prerequisite. No API or
SDK source was changed.

## Qualification boundaries

Root integrated the unchanged gateway module and actual server/Dockerfile wiring
with 38 passing gateway tests, including actual HTTPS ACK-loss uncertainty.
The new stage's Node tests are protocol models; host tests exercise real owned
FD/flock/exclusive filesystem/fsync cleanup with simulated observation and root
ownership. They do not certify a deployed Linux/Docker image or the complete
FE-bound parent. The earlier receiver package separately proves actual pinned
API/TLS/PG16 decisions. Those separate results do not imply a joined staging run.

`prepare-p2-transport-fault.mjs SETTINGS_JSON` only prints a plan with
`standaloneActivationEligible:false`. The concrete certification parent, fixed
host adapter, real provider/worker invocation and fault/reconciliation/recovery
evidence are OPEN. Native/lease expiry/process-death evidence must keep its
owned-versus-deployed classification; no Vercel kill control or new test barrier
was invented. This component does not complete S12/P2-11/P2-12/G2.
