# S13 authority timing qualification

This package measures the deployed Phase 2 authorization boundaries required
by staging scenario S13. It does not add a public endpoint, expose an
application JWT, change a clock, generate or rotate a signing key, enable a
schedule, deliver a lifecycle command, restore an account, deploy a candidate,
or accept G2.

## Evidence boundary

The current host package is deliberately live-ineligible. Every operation
other than `plan` refuses with `source-authoritative-artifact-adapters-required` until
fixed adapters execute the reviewed browser recorder, pending-state observer,
S12 worker validator, and lifecycle witness against their retained private
artifact bytes. Caller-shaped JSON plus claimed source or receipt digests is
not authority. The JavaScript qualifier remains available only for owned
source fixtures until those adapters are integrated and independently reviewed.

The user-token measurement uses an explicitly operator-controlled,
source-signed Course learner token. The private child imports the existing
`PROFILES` and `signProbeToken` implementation, consumes the exact selected
Course learner current key through the existing identity operator, and uses the
closed v1 learner claims. It is not a captured frontend token and is not proof
that the normal frontend issuer worked. The G2 browser journey owns that proof.

Playback capture calls the actual private Course endpoint
`GET /v1/student/lessons/{lessonId}/playback` for the approved learner, lesson,
course and free grant. Course performs its normal account/access checks and
uses its actual Mux signer. This GET updates only the existing
`video_assets.last_token_expires_at` cleanup fence. The plan and receipts label
that write and learner rate-limit consumption; they do not call it a fully
read-only business operation. No grant, progress, lesson, course or account
state is changed by this package.

The Mux token and URL remain in a mode-0600 private action record until both
expiry observations finish. Common output contains neither credential bytes
nor credential hashes. Finalization unlinks the private capture after both
credentials have expired. This is not a secure-erasure claim.

## Existing entrypoints

- The exact selected gateway container reaches Course at
  `https://course-tls:8443`, with SNI `course-tls`, the mounted `/tls/ca.pem`,
  verified TLS 1.2 or newer, no redirects, and only the fixed protected course
  and playback paths.
- The captured playback token is used only at
  `https://stream.mux.com/{exactPlaybackId}.m3u8?token={exactToken}`. The host,
  path, single query name, JWT subject, `aud=v`, and expiry must all agree.
  Provider redirects, 429, 5xx, network errors and malformed dates never count
  as expiry denial.
- Suspension uses the ordinary owner page `/admin/customer-accounts`, a fresh
  real Google step-up and the existing same-origin command route. S12 owns that
  mutation, the deliberately disabled native schedule, the later real worker
  invocation and protected denials at both receivers.
- The d355 lifecycle persistence package owns database credentials, TLS,
  queries and the post-acknowledgement three-domain witness. S13 consumes its
  final fixed receipt; it does not edit or duplicate the witness.

## Fixed sequence

1. Prepare one owned real customer with an active free grant to the reviewed
   published course/lesson. Keep the learner lesson visible and the owner
   suspension form authenticated and ready. Native lifecycle scheduling must
   remain disabled.
2. Run `capture`. It creates a fresh bounded host lease, issues one controlled
   300-second learner token, proves the protected course baseline, obtains a
   real 600-second Course/Mux playback authorization and proves initial Mux HLS
   access. It creates a new private action directory; it never adopts one.
3. S12 submits `suspend` through the normal owner UI. Do not invoke the worker.
   Run `observe-user` immediately with the exact 202 command receipt. The host
   makes one protected request just before `exp+30` and one at/after it. The
   only passing statuses are 200 then 401. The common receipt reports request
   intervals and poll resolution rather than an infinitely precise transition.
4. After the 401, capture the exact frontend command state with the fixed d355
   frontend observation path. Both deliveries must still be pending with zero
   attempts, no leases, no acknowledgements and no later command. This prevents
   receiver suspension from being mistaken for cryptographic expiry.
5. S12 invokes the real lifecycle worker and proves both receiver commits and
   protected denials. Run the final d355 `lifecycle-account` witness. It must
   report two acknowledgements and zero pending/delivering rows.
6. Run `observe-playback` only after those receipts exist and while the captured
   Mux token has between 30 and 540 seconds remaining. It proves the old token
   still works after suspension, then requires 401 or 403 on the first request
   at/after its exact expiry. No grace is added.
7. The normal learner browser remains visible. Its ordinary renewal occurs
   about 30 seconds before the earlier playback/thumbnail expiry. The revoked
   frontend session must return 401 and the source browser artifact must show
   the `mux-player` count becoming zero. This early safe removal is reported as
   observed; it is not described as removal exactly at 600 seconds. A separate
   deliberately stalled renewal, if required, belongs to the S12 browser fault
   driver and is not reimplemented here.
8. Run `finalize` with the S12 machine receipt, browser source/trace receipt,
   post-expiry pending observation and final d355 receipt. Restore remains an
   S12 cleanup action after finalization.

Every live phase obtains a fresh `/run/lock/lash-her-release.lock` lease. No
lease exceeds 600 seconds. Waits recheck source, configuration, candidate and
lock ownership at least once per second. The exact ten-container inventory is
rechecked at phase boundaries and before and after each network child. Retained
capture/window records must match the exact action, binding, candidate and
configuration before reuse. No process or lease is assumed to survive between
phases.

## Fixed host interface

The host entry reads one bounded JSON packet from stdin with exactly `version`,
`operation`, `bundleDirectory`, `configurationDirectory`, `reviewed`, and
`private`. Operations are `plan`, `capture`, `observe-user`,
`observe-playback`, and `finalize`. There is no caller-selected URL, endpoint,
command, resource ID, key, token, clock, output path, timeout or grace value.

The reviewed input binds the existing identity reviewed scope, exact six S13
files, embedded program digest, action-private directory, and separate exact
source digests for the browser validator, pending-state observer, lifecycle
witness, and S12 worker evidence. `plan` reads no credential and calls no network. Live
execution is staging-only, exact-source, exact-candidate, exact-configuration,
exact-container and fixed-profile.

## Browser and persistence evidence

S13 does not turn a caller-provided boolean into browser proof. The S12 browser
receipt must identify an external source-bound machine artifact, include the
normal 202 suspension network observation, the ordinary 401 renewal network
observation and at least two trace events supporting a zero `mux-player` count.
The artifact and validator-source digests remain distinct from the S13 host
receipt.

Capture and initial Mux access must precede the suspension receipt, and the old
user token must remain accepted after that receipt. The pending-state receipt
is captured after user-token denial and before the worker. The final persistence
receipt is captured after the worker. S13 binds the browser, pending, S12 and
lifecycle receipts to the same command/version and to separately reviewed source
digests. Any worker attempt before the user-token
boundary, later command, lease, acknowledgement, source/configuration drift or
unchecked prior persistence record refuses qualification.

## Key rotation is separate

The existing identity probe establishes current/previous overlap and reports
`keyRemovalVerified=false`. It is not a rotation test. A later reviewed action
must retain a previous-key token privately, deploy an exact configuration with
only the previous slot removed, rebind the actual image/runtime, prove the old
token is rejected and the current token remains accepted, and emit only slot,
status and source/configuration hashes. This package performs none of those
steps.

## Non-live checks

Run the source and host tests from the repository root:

```sh
node --test ops/platform/p2-lifecycle-authority-timing.test.mjs
python3 ops/platform/host/p2_lifecycle_authority_timing_test.py
```

Owned tests use synthetic HTTPS observations and a real POSIX flock/process
boundary. They do not call staging, Mux, Course, Community or a database and do
not establish S13 or G2 completion.
