# Final P1 staging acceptance and admission

P1-09 has a local implementation in `ops/platform/host/staging_admission.py`. It joins reviewed P1-C01–C06 evidence, checks the actual runtime/provider/maintenance bindings, fences and observes admitted transport work, restores qualified maintenance timers, and deliberately admits recovery. It does not run migrations, rebuild or replace containers, promote a frontend, or enable customer features. Its isolated rehearsal is not live acceptance.

The recorded C3 candidate predates this component and the gateway admission image/mount. Do not run this component against C3, change its retained configuration, replay SQL, or repeat C3. A future reviewed candidate must contain the gateway source and directory mount below, pass its required exact-source CI/image checks, and refresh affected qualification. Reuse unaffected frontend/native evidence with its actual applicability. G1 stays blocked until remaining live criteria and the reviewed final action pass.

For compatible rollback, use the retained operator-owned configuration input, not the running snapshot whose gateway/TLS files belong to the container user. The rollback component validates input ownership, private modes and environment bindings before fixture writes or runtime stops. Preserve failed attempts and their receipts; do not change snapshot ownership to bypass this check. The recreated-host paths are `cold-restore/configuration-input` for copying and `cold-restore/configuration` for the original running mounts; their reviewed file hashes are identical.

## Inventory and bounds

| Surface                                                                                           | P1 disposition and closing observation                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Course public/admin/student GET routes                                                            | Existing workload/application authorization remains. Reads do not acquire mutation permission.                                                                                                                                                                 |
| Course admin authoring, admin grants/revocations and student progress mutations                   | `newWork` fence stays false in the P1 profile. The gateway applies it to every caller, including historical frontend URLs.                                                                                                                                     |
| Internal entitlement grant/reconcile/revoke commands                                              | Separately controlled by `recovery`; service authorization, idempotency and durable work remain required. Free/customer enrollment entrypoints belong to later phases.                                                                                         |
| Exact signed Mux callback                                                                         | Recovery class; signature validation stays in the Course API. Enabling forwarding does not configure a provider webhook or certify the later Mux feature.                                                                                                      |
| Course publisher/snapshot and Community repair workers                                            | Already running; exact eight-container/image identity and C04/C05 business/lease recovery evidence are required. This component never restarts them or claims gateway drain stops private workers.                                                             |
| Native frontend schedule                                                                          | The selected definition is the bounded expiring qualification probe. Keep it disabled and observe the existing 16-second drain (15-second function cap plus margin). No persistent business definition is eligible in this P1 profile.                         |
| Certificate and watchdog timers                                                                   | Both disabled/idle before acceptance; require exact installed unit bytes, current TLS pairs/served leaves, and an actual successful certificate systemd invocation that reports a current-certificate no-op. Enable only these two timers after fencing/drain. |
| Six frontend integration capabilities                                                             | All false. P1 admission does not turn on customer access, Course reads, checkout, entitlement recovery entrypoints, or Community reads/writes. Existing private durable workers are a separate operational surface.                                            |
| Existing site checkout, Square callbacks, outboxes, ordinary crons and shared frontend DB writers | Unchanged and outside this P1 gateway profile. Pending frontend SQL, complete historical-deployment fencing and writer drain remain P2-00.                                                                                                                     |

Gateway mutations are admitted and counted synchronously before reading the body. The existing 12-second request deadline covers body/upstream transport; the controller allows at most 13 seconds for observation. A client/upstream disconnect or timeout records unresolved mutation uncertainty. Zero active requests cannot qualify drain while that uncertainty remains. Reconcile actual business state before a separately reviewed recovery; the controller does not erase counters or restart a process to hide them. HTTP drain alone is not a database/worker drain claim.

The shared host release/watchdog lock remains held throughout host checks, fencing, maintenance changes, final evidence recheck and durable receipt publication. The existing lock acquisition waits at most 30 seconds. The certificate no-op invocation must have completed separately before this action; starting it while this lock is held would report busy and cannot qualify maintenance.

Completed oneshot units may be unloaded after becoming inactive, clearing their live `InvocationID` and process timestamps. The verifier therefore correlates the latest manager start/completed job and the certificate process result by trusted journal boot/invocation IDs and monotonic ordering. It requires a successful completed start job and exactly one current-certificate no-op result; stale, failed, incomplete, foreign-boot/unit, busy or renewed results refuse. This behavior was observed on the recreated host; the original wrapper failure and later read-only reconciliation remain separate evidence. See the systemd [trusted journal fields](https://www.freedesktop.org/software/systemd/man/257/systemd.journal-fields.html) and [unit/process property lifecycle](https://freedesktop.org/software/systemd/man/latest/org.freedesktop.systemd1.html).

## Candidate configuration

The gateway config keeps `maintenance: true` and adds:

```json
{
  "admission": {
    "file": "/admission/state.json",
    "releaseId": "<exact release ID>",
    "candidateSha256": "<SHA-256 of original release.candidate.json bytes>"
  }
}
```

The candidate-pinned Compose file mounts `${RELEASE_DIR}/admission:/admission:ro`. The runtime snapshot creates that directory with host ownership; it contains only public admission state. Missing, malformed, oversized, symlinked or wrong-candidate state refuses mutations. Atomic file replacement becomes visible through the directory bind without a rebuild/restart. The local-only gateway operations endpoint reports the current state hash and active/uncertain mutation counts; the public route map cannot expose it. Older configs retain their existing maintenance behavior. Older images cannot acknowledge the new protocol and cannot qualify admission.

The P1 controller writes `newWork: false` throughout and sets `recovery: true` only at the final step. The two controls are independent in the gateway. Future feature entrypoints still need their own six rollout controls and stage prerequisites; this host state is not a remote feature flag service or a replacement for frontend writer fencing.

## Reviewed evidence input

Use an `acceptance.json` in the existing protected off-host/host handoff storage. It is an index of original receipts within this action, not another approval ledger. Preserve original receipt bytes, including failures. The operator reviews what each receipt establishes; a matching hash cannot independently prove an asserted outcome.

The index fields are:

- `version: 1`, a unique `actionId` matching `p1-admit-...` and `maintenanceInvocationId` from the actual current certificate service invocation.
- `binding`: `environment: staging`, exact `releaseId`, original `candidateSha256`, `hostMachineId`, `frontendProjectId`, `frontendSourceCommit`, `frontendDeploymentId`, `images` for gateway/Course/Community runtime, and `configurationSha256` for every file in `staging_state.CONFIGURATION_FILES`. Hashes use lowercase SHA-256 without a prefix. Do not include credential values.
- `features`: all six names from the inventory above with Boolean false values.
- `producers`: `runningWorkers: ["course-publisher", "course-snapshot", "community-worker"]`, `nativeSchedulesEnabled: false`, and `maintenanceTimers: ["lash-her-watchdog.timer", "lash-her-certificates-staging.timer"]`.
- `admission: {"newWork": false, "recovery": true}`.
- `criteria`: all six keys and every named check from `staging_admission.CHECKS`. Each check has `outcome: passed`, its required `evidenceClass`, `applicability` and one or more `receipts: [{"path": "relative/original.json", "sha256": "..."}]`. An exact-image check binds only `candidateSha256` and `images`; live/provider checks bind the entire selected binding. Reused evidence must be reviewed for applicability, including changed-host transport. Unsupported evidence classes, missing checks, changed bytes, traversal/symlinks and mismatched identities refuse.

This finite input covers the existing P1 criteria, including the full ENV-01e negative cases. It does not invent an approval expiry, external signature, monitoring requirement or billing gate. C07 is generated only by successful final execution. A generic `approved` field or a startup receipt cannot replace these checks.

## Plan and apply boundary

From the exact published/reviewed operator checkout, with private canonical paths outside any checkout:

```sh
python3 ops/platform/host/staging_admission.py \
  /private/bundle /private/runtime-configuration /private/evidence /private/new-admission-result
```

Plan reads public candidate/job/schema/config/evidence files only. It does not read runtime env/key contents, instantiate a provider client, access Docker/DBs, create output or change state. Reviewed private configuration hashes are checked against actual bytes only by apply. The displayed plan binds the exact candidate, target, configuration, evidence and intended recovery-only profile.

The future reviewed live action uses the same command with `--apply --confirm staging/<releaseId>/<actionId>`. Resolve the existing Vercel credential privately at runtime as documented by the release policy; never put it in arguments, evidence or chat. Root/Linux/local-engine, exact container/source/image/provider/alias/disabled-native and installed maintenance checks precede mutation. No live command was executed during local implementation.

## Failure and recovery

Any missing/stale identity or criterion refuses. A drain timeout keeps admission closed and skips maintenance restoration. An ambiguous timer enable is tracked before the call and disabled during failure suspension. A failed final acknowledgment refences the affected gateway mutations, disables requested timers, retains independent durable workers, and reports uncertainty if the suspension itself cannot be verified. No SQL, build, promotion or container retry occurs.

`admission-started.json` and `admission-outcome.json` are exclusive, fsynced records; existing outputs cannot be overwritten or reused. A hard process death retains the intent and whatever atomic state actually reached disk. Death before admission leaves the fence closed; death immediately after recovery admission may leave recovery open with no terminal receipt, while new work remains closed. Do not infer acceptance from that state. Inspect the gateway hash/counters, units, native provider and business/recovery outcomes before a deliberate new action. Do not automatically replay a failed or incomplete attempt.

Success is `STAGING_P1_ACCEPTED_RECOVERY_ADMITTED`, with C01–C06 receipt references, exact bindings, timer disposition, state hash, `releaseAccepted: true`, `newWorkAuthorized: false` and `recoveryAuthorized: true`. It certifies this P1 profile only. Task/G1 closure still requires the actual remaining live evidence and operator review.
