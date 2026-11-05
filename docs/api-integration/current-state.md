# Current integration checkpoint

Updated November 3, 2026 (Toronto). Final admission completed November 4 at 01:27:39 UTC, with independent postflight at 01:29:33 UTC. [The tracker](../../API-INTEGRATION-EXECUTION.md) owns task status; [release policy](release-policy.md) governs future releases.

## Accepted P1 state

P1-C01–C07 are satisfied for the recovery-only staging profile. P1-01–P1-07, P1-09 and G1 are DONE within their listed scopes. P1-08 monitoring remains DEFERRED; billing and external signing/executor ceremonies remain excluded. G1 does not activate or certify customer, commerce, media or Community features from later phases.

The explicitly approved C07 action deployed qualified candidate `p1-41748860504-1` without overlapping versions, verified current databases read-only, built and verified the exact frontend through genuine server SDK OIDC, promoted staging domains and completed native scheduler qualification. Final action `p1-admit-20261103-1` returned `STAGING_P1_ACCEPTED_RECOVERY_ADMITTED`. The [original final receipt](baselines/2026-11-03-p1-c07-verified/final-receipts/admission/admission-outcome.json), [independent postflight](baselines/2026-11-03-p1-c07-verified/final-receipts/admission/independent-postflight.json) and [validation](baselines/2026-11-03-p1-c07-verified/validation.json) are retained off-host.

- Gateway admission: `newWork: false`, `recovery: true`; valid state hash acknowledged. Gateway configuration retains `maintenance: true`; the independent host admission controls the qualified recovery class.
- All six frontend feature controls remain false. Native/business schedules remain disabled. The expiring release probe is not an eligible persistent business schedule.
- Certificate/watchdog timers are enabled and active. Actual current-certificate and healthy-watchdog no-ops passed before admission; container starts/restart counts remained unchanged through independent postflight.
- Eight current services are healthy. All 39 prior Course and 12 prior Community business/audit rows were preserved through the switch and final postflight. No migrations, new fixtures, host recreation, C3 replay or production changes occurred in C07.
- Initial migration history remains 17 Course and 10 Community migrations applied once; frontend was current at 80/80. The new candidate's database checks verified complete current lineage/schema/roles/TLS read-only. Pending frontend SQL and full historical-deployment writer fencing remain P2-00.

## Exact active identities

| Surface | Active binding |
| --- | --- |
| Candidate | `p1-41748860504-1` |
| Executed bundle manifest SHA-256 | `09f2935fcac8130b6abfdfb0814e8da104106efe6ca9243de3a3e5553d16cce5` |
| Qualified build manifest SHA-256 | `5e72781adc30a726c8ec42b6989af2dd71c999693fe18996cadf88536894c65b`; parsed objects equal, original serializations retained |
| Frontend source | `b99d4f346696f897fa6a6729dfcc52d6503fe8d6`, merged PR66 |
| Frontend deployment | `dpl_Bqc171V1RouKNkjcrnVtWB1imwKH`, staging.lashher.com |
| Staging project/target | `prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM`, business `APP_ENV=staging`, Vercel Production target |
| Course source | `2ba96d5a8db46ef3470bb9759c6e9d4f84e7ed2b` |
| Community source | `537a074e82c14d105c10b70fcecb2f9005753c9f` |
| Staging host | Machine `ec2146be041cf26fda0a7986db4be3b6`, IPv4 `184.196.129.231` |
| Runtime configuration | `/var/lib/lash-her/releases/staging/c07-qualify-20261103-1/configuration` |
| Bundle | `/var/lib/lash-her/releases/staging/c07-preparation-20261103-1/bundle` |
| Final acceptance evidence | `/var/lib/lash-her/releases/staging/c07-acceptance-20261103-1` |
| Final result | `/var/lib/lash-her/releases/staging/p1-admit-20261103-1` |

The six immutable image digests and all eight current container IDs are in the original final receipts. Do not use C3/C05 container identities for current operations. The canonical maintenance service checkout remains `1133cc8`; its installed hashes, units and actual new mounted TLS were verified. Qualified C07 operator source is `b99d4f3`.

## Qualification evidence and corrections

All ten post-merge CI checks passed in run 41747292820; candidate build 41748860504 passed six image scans, native provenance/SBOM/signature verification, manifest attestation, the 15-case isolated integration harness and frontend migration rehearsal. Independent attestation/hash checks, 27 published-gateway/OIDC/policy/quota cases, current host boundaries and genuine frontend workload passed.

C04/C05 original successful live recovery/rollback rounds remain unchanged. Both current API images have identical filesystem layers, source and execution configuration to their qualified C04/C05 counterparts; environment/private TLS hashes and schema/targets are unchanged. The [explicit applicability review](baselines/2026-11-03-p1-c07-verified/acceptance-evidence/applicability.json) joins those original rounds with the fresh non-overlap/preservation/current-state checks. It does not claim a new unperformed previous-image round. Recreated-host external observations are reused with freshly verified identical host ingress/publication; no new external measurement is claimed.

Three provider-classified native invocations passed. One completed 17.875 seconds after disable, beyond the initial function-drain wait. The complete unfiltered provider inventory, refreshed after the observation window, verified 288.684 seconds quiet after that final completion. [Native verification](baselines/2026-11-03-p1-c07-verified/native-verification.json) records the extra invocation explicitly. The initial 16-second wait is not treated as a provider queue/cancellation bound.

The first C07 invocation refused before creating its host action directory because its driver compared Python tuples to JSON lists. The user approved the corrected representation-only retry. The later admission preflight found umask 077 had made the public state directory 0700; the gateway correctly kept mutations closed. Only that root-owned public-state directory was aligned to documented 0755; private file hashes and containers stayed unchanged. Final admission then passed. The source regression fix is published in [draft PR67](https://github.com/princessdardan/lash-her-frontend/pull/67); all 282 host tests passed locally and all ten checks in CI run `41754456396` passed. It changes future snapshot construction, not the accepted application candidate.

## P2-00 implementation in progress

The [pending frontend SQL design](p2-00-frontend-quiescence.md) records the writer inventory, admission/drain requirements, a 300-second observation budget that cannot substitute for actual drain, and failure/recovery behavior. The first implementation retains the physical PostgreSQL migration session/advisory lock through an in-process frontend continuation and rechecks lineage/schema/grants afterward. A failed continuation preserves the successful SQL receipt and returns a failed terminal result without automatic SQL replay or traffic authorization.

The [foundation evidence](baselines/2026-11-03-p2-00-foundation/validation.json) records 163 platform tests, 27 host regression tests, a 20-test focused subset and owned PostgreSQL16/18 runs (14 checks each). The generated inventory covers the selected source's 55 route files and 50 exported server actions. Read-only project metadata returned 25 retained staging deployments, seven READY; this does not establish their database bindings or an exhaustive shared-database producer inventory. The implementation and design are published in [draft PR68](https://github.com/princessdardan/lash-her-frontend/pull/68), targeting `staging`. No live database, credentials, provider configuration or admission were changed. P2-00 remains IN_PROGRESS: real whole-operation admission, historical-deployment bootstrap/fencing, drain accounting and the parent release/restoration coordinator still require implementation and end-to-end qualification. Do not enable pending frontend SQL from the foundation receipts.

## Retained history

C3 completed once at 20:37:43 UTC November 3 from source `1133cc8`. Its receipts and seven-file ACME reconciliation remain historical. The two failed C04/C05 attempts, separately approved baseline/retained-work recoveries, and successful C05 action `rollback-p1-c05-20261103-3` remain immutable in the [recovery review](operator-live-recovery-rollback-review-20261103.md). The selected C05 runtime is the immediate previous recovery reference; retain its configuration and earlier snapshot. Do not replay C3 or migration SQL.

The [C07 review and results](operator-c07-release-review-20261103.md) preserve approvals, exact drivers, original receipts and corrections. The frontend and sibling API working copies contain independent edits; use exact source commits and inspect actual Git state. Monitoring remains deferred. Future production promotion requires its separate explicit release action.

## Phase 2 goal opening - November 5, 2026

A user-approved goal is implementing remaining Phase 2 in isolated worktrees; see [the execution record](phase2-goal.md). PR #91 shipping preparation remains external and open at the opening observation. The committed tracker was behind this accepted checkpoint and has been reconciled; G1 is not reopened. Lifecycle export/retention/denial defaults were approved in [the decision](decisions/2026-11-05-p2-lifecycle-policy.md). Six workers are active. Source-level authentication/admission foundations do not qualify live pending SQL, whole-application fencing, provider integration or G2. No live environment was changed.
