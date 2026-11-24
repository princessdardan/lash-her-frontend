# Course and Community integration

Start at [Active staging work](../../API-INTEGRATION-EXECUTION.md#active-staging-work). Course and Community are running on protected Lightsail staging. Take the first unfinished item in the protected staging queue, deploy the affected components, and smoke-test the changed flow. Record the result and continue to the next independent item. Brief staging downtime is acceptable. The rest of the tracker preserves prior results and longer-term scope.

## Read in this order

1. [Active staging work](../../API-INTEGRATION-EXECUTION.md#active-staging-work) for the queue, deferred work and holds.
2. [November 20 checkpoint](current-state.md#november-20-lightsail-staging-update) for the live deployment and test-account scope.
3. [Routine staging release policy](release-policy.md#staging-review-release-verify) for the deploy and smoke-check sequence.
4. The [product scope](../../API-INTEGRATION-PLAN.md), [approved contracts](../../contracts/api-integration/v1/README.md) and [task briefs](briefs/README.md) for the selected flow.

## Working rules

- Use existing tests, sandbox flows and deployment output. Historical procedures for compiling evidence, receipts and separate manifests are reference material. [Release policy](release-policy.md) governs staging and production actions. [Migration policy](migration-policy.md) governs SQL, lineage, locking and target safety.
- [Launch capacity](decisions/2026-11-10-launch-capacity.md) uses 50–100 registered users and 5–10 concurrent learners, with proportional Community, enrollment and reconciliation allowances. The larger SCALE-01 stress/recovery profile is outside launch gates; launch recovery correctness and restore objectives remain required.
- [Environment map](p1-environments.md) distinguishes business `APP_ENV` from Vercel targets and defines exact project/dataset bindings. [Input register](external-prerequisites.md) owns unresolved business/provider inputs.
- The [P1 staging history](p1-qualification-coverage.md) is available when working on ingress, scheduling or recovery.
- P0/G0 and accepted P1-01/P1-02/P1-05 completion remain. P1-08 monitoring is deferred; billing/headroom and external signing/executor ceremonies are excluded. Readiness, audit, diagnostics and recovery remain required.
- Completed C3 is not a pending action. Historical approvals and commands are not permission to replay them. [History](history/README.md) preserves chronology, original text and immutable evidence links.

## Reusable operating references

| Work                                      | Reference and implementation limit                                                                                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact source/candidate publication        | [Source gate](../../ops/platform/source-gate.md), [platform overview](../../ops/platform/README.md); required source CI/artifact checks remain per candidate.                                                                                                 |
| Three-database migration components       | [Operator migrations](operator-migrations.md), [frontend component](operator-frontend-migrations.md); current read-only frontend verification is implemented, pending SQL needs P2-00.                                                                        |
| API runtime startup                       | [Runtime component](operator-runtime-release.md); readiness does not admit gateway writes.                                                                                                                                                                    |
| Initial staging coordinator               | [Coordinator](operator-staging-qualification.md), [frontend provider operations](operator-frontend-release.md), [workload probe](operator-frontend-workload-probe.md); remaining P1 criteria/final admission are explicit in P1-09/P1-07.                     |
| Owned image reproduction                  | [HTTP/quota checks](operator-published-image-quota-check.md), [rollback/recovery checks](operator-published-image-recovery-check.md); disposable isolated DBs only, not a live acceptance claim.                                                              |
| Pending frontend SQL / production release | [Release coordination brief](briefs/release-coordination.md): P2-00/P6-00 are implementation tasks, not currently supported apply instructions.                                                                                                               |
| Existing site and editorial content       | [Site checklist](../production-cutover-checklist.md), [Sanity workflow](../sanity-staging-production-workflow.md), [scheduled jobs](../scheduled-jobs-runbook.md), [Fresha compatibility](../fresha-cutover.md). Content replacement is a separate operation. |

P1-C01–C07 and G1 are complete for qualified candidate `p1-41748860504-1` under the recovery-only staging profile. The [current checkpoint](current-state.md) and [final original receipts](baselines/2026-11-03-p1-c07-verified/validation.json) record actual admission. New work, all six customer capabilities and native/business schedules remain disabled; certificate/watchdog timers are enabled. This does not certify later-phase features or pending frontend SQL.

P2 staging certification is held. Resume P2-00 only when a selected and approved change needs pending frontend SQL on a shared database. The [P2-00 design](p2-00-frontend-quiescence.md) and [release coordination brief](briefs/release-coordination.md) describe that conditional path. The profiled pending-SQL coordinator still refuses live apply.

## Change and handoff discipline

Keep task priorities and blockers in the single frontend tracker. Use a concise result or existing run link when it changes a decision. Resolve business inputs in the feature that needs them and keep the three scope copies synchronized.

The local `com.lashher.api-docs-sync` macOS LaunchAgent runs [the sync script](../../scripts/sync-api-integration-docs.py) each minute while logged in and fetches origin changes every five minutes. It applies changes from local and fetched branches and saved edits in registered worktrees. It writes the plan to the frontend, Course API, and Community API checkout roots and the tracker to the frontend root.

For an immediate check, run:

```sh
python3 "$HOME/Library/Application Support/Lash Her API Docs/sync-api-integration-docs.py"
```

That directory holds `conflicts.txt` when edits overlap and `sync.log` with run output. Reconcile overlapping edits in the frontend copy, then add `--ack 'SOURCE'` to the command using the source text after the pipe in the conflict report. Independent changes continue to sync.

For a new workspace, put the current plan and tracker in the frontend checkout first. Run `python3 scripts/sync-api-integration-docs.py --workspace /path/to/workspace --state-dir /path/to/state` from the frontend root. The first run mirrors the frontend plan and records the existing branch and worktree history as its baseline. To automate future runs, schedule the same command with `--fetch` and reuse the same state directory.

The [November 3 audit](reviews/2026-11-03-planning-documentation-audit.md) and [repair record](reviews/2026-11-03-documentation-repair.md) explain these documentation changes. They do not create live qualification results.

[P1 boundary qualification](p1-boundary-qualification-20261103.md) retains the earlier boundary checks, including the [genuine frontend OIDC pass](operator-frontend-workload-review-20261103.md) against the recreated gateway. Later C04–C07 and recovery-only G1 closure are recorded in the current checkpoint and final evidence above.
