# P2 application-user JWT rotation certification

This source package prepares the deliberate staging rotation of exactly four
application-user JWT profiles:

- Course learner
- Course administrator
- Community member
- Community administrator

It does not rotate account-lifecycle, enrollment, publisher, internal-service,
session, provider, database, workload, or ingress credentials. It does not add
a Community feature or a public debug/token endpoint.

## Current execution boundary

The package includes a source-fixed config-only parent, single-use SSH
transport, exact source-CI/install operator, typed host broker/scope, canonical
staging-origin observer, and normal frontend Course read recorder. The Node
parent and transport share the same frozen reviewed plan. The controller
checks the retained review and writes atomic, private records in the action
result directory. The managed source joins the profiled replacement lease,
scoped browser writer permit, host-owned retained state, and independent
post-reap closure. The live entry refuses before remote work pending an
integrated rehearsal on owned infrastructure. Qualify that path and review the
managed entry switches before freezing the staging candidate. The operator
source must match the released frontend source. Dardan separately starts the
reviewed staging rotation and retains its deployed evidence.
`keyRemovalVerified` remains false outside a successful joined run.
The parent retains the Linux release
flock and frontend PostgreSQL physical advisory/nonce lock throughout each
configuration mutation, runtime recreation, frontend build/promotion, and
proof. Retained-READY recovery and failed/canceled forward recovery are not
rotation authority.

The fixed components have no standalone activation path or generic command
callback. The transport handle and controller authority are process-private,
single-use capabilities minted only by the fixed source parent.

Browser authentication and Course reads use only the fixed canonical origin
`https://staging.lashher.com`. The immutable `*.vercel.app` deployment URL is
retained separately as provenance. Before arm and continuously while active,
the host brackets a protected workload request with two provider alias reads
and requires the alias, READY deployment, source, release, configuration,
authentication origins, feature controls, and writer binding to remain exact.

## Reviewed private configurations

The action binds three root-owned configuration references under
`/var/lib/lash-her/releases/staging`:

1. `baseline`: the old key is current and no previous application-user key is
   configured.
2. `overlap`: the new key is current and the old key is previous for all four
   profiles.
3. `currentOnly`: the new key is current and every previous application-user
   key is absent.

Restoration aliases exactly the reviewed `baseline` or `overlap` directory;
there is no caller-selected fourth configuration.

The future parent must compare configuration values privately. Across phases,
every non-profile value must be byte-identical. The overlap configuration must
contain eight distinct profile keys, all separate from lifecycle, enrollment,
publisher, service, session, provider, database and workload credentials.
Common receipts retain only existing whole-configuration record bindings; they
contain no credential value or per-key credential hash.

The private reviewed plan separately retains a byte hash for each
credential-bearing directory. That private hash is checked in process and is
never copied to controller or common evidence. The public phase SHA is the
noncredential configuration-record identity and must differ from the private
byte hash.

The only allowed per-build difference outside those three base configurations
is the existing `frontend_probe.prepare` overlay:
`LASH_RELEASE_PROBE_SECRET`, `LASH_RELEASE_PROBE_EXPIRES_AT`,
`LASH_RELEASE_SCHEDULER_QUALIFICATION`, and
`API_GATEWAY_STAGING_ORIGIN`. The fixed helper generates a fresh overlay for
each build. An old or expired probe record is never reused as workload proof.

Vercel Sensitive values are not readable after creation. The adapter never
requests or claims secret-value readback. It inventories fixed Production
metadata first, writes every desired profile value from the reviewed private
reference and verifies the held scope around every provider request. It
retains an exclusive intent before each write and a sanitized acknowledgment
after the verified response. The aggregate receipt requires those individual
records for GET-first reconciliation. A lost or partial acknowledgment
leaves the original attempt available for review. The later staged build
verifies the exact deployment and workload.

## Fixed order

1. Verify the exact source, candidate, host, ten-container inventory, runtime
   target, current frontend deployment, closed native schedules, exact
   read-only runtime mounts, complete in-container API environment values, both
   API database-current receipts, and both held locks. Retain mutation intent
   before any provider or Compose call.
2. Recreate Course and Community with one registered Compose mutation on the
   exact same images using `overlap`.
   Verify the receiver overlap configuration. The existing deployed Course
   verifier probe supplies the actual Course runtime current/previous
   configuration and module proof. The Course HTTP child deliberately reports
   no configuration-observation claim.
3. Create and promote one exact frontend `overlap` build. Verify the actual
   protected Course learner/admin frontend operations use the new current key.
   Customer and administrator browser contexts authenticate through the normal
   frontend. The parent then durably records one exact source-issued read
   window, enables frontend `newWork` only for that window, keeps recovery and
   gateway admission closed, performs the existing learner and administrator
   Course GETs, closes admission, and proves zero active and uncertain ledger
   operations. The signer-read window is fixed at at most 60 seconds. It is not
   globally read-only because the existing administrator GET writes its
   admission-ledger operation.
4. Record when the old frontend deployment stopped issuing. Keep overlap for at
   least 330 seconds: the 300-second maximum token lifetime plus 30-second
   verifier skew. Continuous guards must retain source, candidate,
   configuration, runtime, provider intent, and both locks.
5. After that drain, promote one exact frontend `currentOnly` build while
   both APIs still accept overlap. Verify the current frontend signer with
   the protected learner and administrator Course reads before issuing any
   proof tokens. Build, promotion and browser authentication consume no part
   of the proof tokens’ 300-second lifetime.
6. Record the one-use capture intent. Privately issue controlled, unexpired
   old and new tokens for all four profiles and prove both are accepted while
   the receivers still run overlap. The exact pairs stay in the host's
   mode-0600 action record and are read directly by both receiver observers.
   The capture RPC returns only status, profile, issuance and expiry. The
   controller retains signer references and the profile timing evidence. An
   unqualified retained capture intent requires review.
7. Recreate Course and Community on the same images with `currentOnly`.
   Prove that each exact, still-unexpired old token is rejected and its paired
   new token is accepted. A lost receiver mutation acknowledgement is
   reconciled GET-first against the retained capture. Course learner/admin
   use real protected HTTPS operations with exact request IDs and statuses.
   The `deployed-private-community-verifier` evidence comes from the fixed
   child inside the exact selected Community container. It imports the real
   member/admin verifier, proves previous-key absence and verifies moderator
   capability enforcement.
8. Recheck the current runtime and frontend boundary and the retained signer
   proof. Prepare the terminal receipt while the frontend session is still
   held, stop the observers, close that session, and use an independent
   exact-image proof that its backend is absent, both advisory locks are
   acquirable, and frontend admission remains closed and drained. Only the
   final joined receipt may set `keyRemovalVerified: true`.

Outside the source-fixed authentication and signer-read windows, frontend
admission remains closed. Each authentication window is fixed at 300 seconds;
each signer-read window is fixed at 60 seconds. The independent observer
accepts only the exact recorded phase, deployment, configuration, source,
physical session, epoch transition, and bounded active operation count.
Network errors, expiry, process loss, uncertain operations, or an unverified
drain fence the action closed.

## Failure and restoration

Every Vercel mutation is preceded by an immutable intent. Reconciliation is
GET-first. Each action permits at most one build and promotion per phase.
Unknown/lost POST outcomes, mixed API configurations, source/runtime drift,
lock loss, child cleanup uncertainty, or an unsupported response close
admission, terminate and reap registered mutators, and remain
`REQUIRES_REVIEW`; they are never retried automatically.

Deliberate restoration can use only the exact last fully qualified reviewed
configuration: `baseline` before overlap qualifies or `overlap` before removal
qualifies. Restoration re-runs configuration, runtime, frontend workload, and
profile guards. It does not run SQL, prepare roles, change database login,
replay a migration, recreate a terminal receipt, or silently reopen admission.
If any mutation acknowledgement or containment step is uncertain, automatic
restoration is refused.

## Evidence classes

The final receipt discloses one evidence class for each profile:

- `actual-protected-course-http`
- `deployed-private-community-verifier`

It also reports observed status, source commit, exact container/image,
configuration record binding, and timing. It never reports JWT bytes, signing
keys, key hashes, subjects, customer data, or provider credentials.

## Source checks

```sh
node --test ops/platform/p2-identity-key-rotation.test.mjs
node --test ops/platform/p2-identity-key-rotation-controller.test.mjs
node --test \
  ops/platform/p2-identity-key-rotation-operator.test.mjs \
  ops/platform/p2-canonical-browser-origin.test.mjs \
  ops/platform/p2-identity-key-rotation-parent.test.mjs \
  ops/platform/p2-identity-key-rotation-browser-recorder.test.mjs \
  ops/platform/p2-identity-key-rotation-session-closed.test.mjs
python3 -m unittest \
  ops/platform/host/p2_canonical_browser_origin_test.py \
  ops/platform/host/p2_identity_key_rotation_test.py \
  ops/platform/host/p2_identity_key_rotation_adapter_test.py \
  ops/platform/host/p2_identity_key_rotation_parent_test.py
```

The host's close-prepared receipt records the exact evidence while the frontend
session is still held. The independent supervisor publishes the terminal after
the broker exits, the fixed database observer repeats the closed-session
result, and the scoped observer containers are absent.
The supervisor verifies the mixed runtime against the reviewed retained and
recreated services. After successful guardian exit, the fixed read-only
evidence action joins the original replacement terminal, rotation terminal,
and closed database session. The guardian also binds the current-only frontend
deployment to its six READY records and the canonical post-removal signer
witness. The Node parent retains the original successor and READY bytes in its
private action directory and returns only their digests.

For a later scoped certification review, select the retained rotation action
and successor digest in `rotationSuccessor`. The planner preserves the
original deployment receipts as release provenance and uses the current-only
receipts for the new action. The guarded path derives both mount roots from
the retained evidence, checks the exact current API configuration, and
challenges the canonical staging deployment while holding both locks.
Mixed-runtime apply remains gated pending an integrated owned rehearsal. Any
held action planned after rotation needs the mixed-runtime entry qualified in
the same staging candidate source.

The rotation requires a second, fresh browser signer witness after both
receivers report current-only verification. Each authentication phase has one
scoped writer epoch for two selected actors. The corresponding protected reads
run with both admission flags closed and keep the same epoch. The managed
replacement lease binds three authentication windows and their exact final
epoch. The Node adapter and independent host observer check all four closed
epochs. The actual staging path must exercise that agreement before the
fixed live entry can be enabled.

These are non-live checks. They use synthetic keys, owned HTTP/verifier
fixtures, and no staging, provider, database, Vercel, Course, or Community
request. They do not establish key removal or release acceptance.
