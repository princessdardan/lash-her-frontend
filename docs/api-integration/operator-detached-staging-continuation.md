# Continue from the completed detach update

**Historical action, executed and failed:** C2 completed replacement and independent SSH verification, then the receiver rejected the ACME issuance log before private files were persisted. The current replacement remains running and attached to the static IP, with Docker/applications absent. See [failure reconciliation](baselines/2026-11-03-c2-runtime-handoff-failure.json). The pre-execution state below is historical; do not rerun this action.

Prepared action `p1-recreate-access-20261103-c2`, exact source `738546802fd56517b4ecd1279666cd267fe2a2cd`, [draft PR64](https://github.com/princessdardan/lash-her-frontend/pull/64). All ten [CI41698228049](https://github.com/princessdardan/lash-her-frontend/actions/runs/41698228049) jobs pass. The [exact-source verifier](baselines/2026-11-03-detached-continuation-exact-source-ci.json) confirms a clean checkout, current canonical branch head, repository/actor and workflow bytes. The [committed-source plan](baselines/2026-11-03-detached-continuation-plan.json) passes all 51 unchanged input hashes and six exact parent receipt hashes. This is a deliberate failure continuation, not an automatic retry or P1 acceptance.

## Actual state and cause

The approved C1 action at `0a53a074b03791caba80f61e2aa9f0060dd8afed` successfully detached static IP `184.196.129.231` from the original instance. CloudFormation reports `UPDATE_COMPLETE` and no failed service events. CloudTrail records a successful `StartInstance` by `cloudformation.amazonaws.com` at 18:45:05 UTC. The local postcondition expected the original to remain stopped, so the action halted before deletion, replacement or private handoff. The precise internal reason for CloudFormation's start is not claimed.

The original instance remains present and running at temporary IPv4 `98.92.183.230`; its container/worker state has not been inspected. The reserved staging IP remains allocated and detached. Snapshot `p1-recreate-access-20261103-original`, ARN `arn:aws:lightsail:us-east-1:691588646557:InstanceSnapshot/a9d51e18-1494-4b6a-ab98-d8936f40c33d`, remains available. No private snapshot contents were fetched. [Failure reconciliation](baselines/2026-11-03-detached-continuation-failure.json) retains the exact action outcome and technical read-only diagnosis.

## Complete continuation

1. Recheck exact clean source/current CI, all 51 unchanged protected inputs, database target/role/TLS bindings, operator IPv4, disabled native schedules and a fresh masked Mux Dev inventory. Keep the existing candidate `p1-41541683416-1` and frontend deployment `dpl_CdhFqwVANweysVe9cCTNpmHfduiy`.
2. Validate the exact detached original instance, unchanged stack/template/parameters and static allocation in account `691588646557`, `us-east-1`. Verify the available existing snapshot and six pinned C1 receipt hashes, including its failed outcome, snapshot, original stop, reviewed/executed detach change set and parent snapshot adoption. Arbitrary action/snapshot/change-set selection refuses.
3. **Normally stop the original instance once, without force**, because CloudFormation started it. Record intent before the request; verify the same instance is stopped and allocation remains detached. Per-container graceful exits cannot be observed and are not claimed. An uncertain stop refuses further removal or retry.
4. Skip the already-completed detach update. Inspect and execute only the remaining ordered CloudFormation original-compute removal and fresh-host creation. Preserve the same static allocation, bundle, Ubuntu 24.04 and `Dardan` key pair. Keep SSH direct ingress at `99.239.187.88/32` plus authenticated AWS browser SSH; private-network/IPv6/password/root SSH restrictions remain as reviewed.
5. Independently verify the replacement's machine ID and public SSH key through Dardan's authenticated Chrome AWS console. Pin that exact key before the same 51 protected runtime/database/signing/TLS/CA/ACME/configuration inputs transfer from this Mac to the replacement staging host.
6. Install the exact public source, reviewed bootstrap/networking and six pinned images; install existing maintenance units disabled. Verify all three databases read-only, then restore the same eight pinned runtime services in maintenance and verify identities/readiness/five TLS/auth probes.
7. Return only allowlisted technical JSON receipts to `/Users/dardan/.local/share/lash-her/recreations/staging/p1-recreate-access-20261103-c2`, mode 700 directories/mode 600 files outside Git. Keep all previous failure receipts unchanged. The new browser proof path is `/Users/dardan/.local/share/lash-her/recreations/staging/incoming/browser-ssh-p1-recreate-access-20261103-c2.json`.

No additional snapshot is created and no detach update is repeated. No migrations, database restore, synthetic business fixtures, raw business-row export, frontend build/promotion, production change, business schedule activation or gateway write admission are included. Retain the snapshot through successful qualification and deliberate cleanup. A failure can prolong staging unavailability; live rollback, lease/retry recovery and remaining P1/G1 qualification stay open.

## Validation and start boundary

[Component validation](baselines/2026-11-03-detached-continuation-validation.json) passes all 170 gateway/platform Node tests, 20 focused checks, ESLint and diff checks. The [actual read-only preflight](baselines/2026-11-03-detached-continuation-readonly.json) passes all six parent hashes, exact detached/running original infrastructure and existing snapshot with a strict read-only API allowlist. Tests prove one normal stop, no detach replay, no new snapshot, no removal after an uncertain stop and no automatic retry. The CloudFormation template and Python host code are unchanged.

Settings are public-only JSON, saved outside Git with mode 600:

```json
{
  "version": 3,
  "action": "p1-recreate-access-20261103-c2",
  "continuationOf": "p1-recreate-access-20261103-c1",
  "sourceCommit": "738546802fd56517b4ecd1279666cd267fe2a2cd",
  "operatorIpv4Cidr": "99.239.187.88/32"
}
```

Run `node ops/platform/cold-recover-staging.mjs plan /absolute/private/settings.json` from the exact clean correction checkout. After all ten exact-source CI jobs pass and Dardan explicitly starts this reviewed continuation, run `node ops/platform/cold-recover-staging.mjs apply /absolute/private/settings.json --confirm staging/p1-recreate-access-20261103-c2` once. A new failure stops for review.

The [accepted release policy](release-policy.md) states: “Dardan reviews failures before a deliberate retry.” The additional normal stop and changed source were absent from C1's approved continuation, so C1's start does not authorize C2. No arbitrary approval expiry or new credential requirement is introduced.

The [bounded publication observation](baselines/2026-11-03-detached-continuation-publication.json) finds zero correction-branch deployments in either Vercel project. Dardan explicitly selected “Run reviewed continuation C2” for this exact source and scope. Execution ended at the private-file receiver; no runtime recovery or P1 completion is claimed.
