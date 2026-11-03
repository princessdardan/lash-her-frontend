# Restore runtime on the existing verified staging host

Prepared action `p1-recreate-access-20261103-c3` continues the failed C2 private-file handoff. C3 does not stop, detach, snapshot, delete or replace a host. Dardan must review the completed evidence and explicitly start this changed action after exact-source CI passes.

## Actual failure and retained state

C2 at `738546802fd56517b4ecd1279666cd267fe2a2cd` completed the normal stop, original removal and replacement. It preserved `184.196.129.231` and independently verified the replacement's SSH identity through Dardan's authenticated AWS browser. The 51-file payload reached the host over pinned SSH, but the receiver rejected `maintenance/acme-staging/initial-issuance.log` with `RECREATION_FILES_ACME_SCOPE_REQUIRED` before creating any private action/input files. No bootstrap, Docker installation, maintenance installation, database checks or runtime startup followed.

Read-only inspection verifies the current host is running, attached and bare. Its identity is fixed:

- AWS account `691588646557`, region `us-east-1`, instance `lash-her-api-staging-host`.
- Instance ARN `arn:aws:lightsail:us-east-1:691588646557:Instance/c88deb32-5f4f-42df-85b4-232609b0d23e`.
- Machine ID `ec2146be041cf26fda0a7986db4be3b6`.
- Retained browser-verified SSH fingerprint `SHA256:OUKp422OkgJ7bR/CuJxCecL+mqxdhPmy23Wqw+cWXGc`.
- Direct SSH `99.239.187.88/32` plus authenticated AWS browser SSH. Private-network, IPv6, password and root SSH restrictions remain in place.
- Available original snapshot `p1-recreate-access-20261103-original`, ARN `arn:aws:lightsail:us-east-1:691588646557:InstanceSnapshot/a9d51e18-1494-4b6a-ab98-d8936f40c33d`. Retain it through qualification and reviewed cleanup.

## Complete continuation

1. Verify clean exact source/current ten-job CI, seven pinned C2 receipt hashes, all protected input hashes, database target/role/TLS bindings, current operator IPv4, unchanged frontend deployment, disabled native schedules and fresh masked Mux Dev inventory. No credential values are printed.
2. Read AWS state through a fixed read-only API allowlist. Verify the exact existing host, static allocation, unchanged stack/template/access policy and retained snapshot. Revalidate the retained C2 browser observation against this same instance. Use strict pinned SSH; confirm the machine ID and that C2/C3 private action directories and Docker are absent. A changed host/key, partial handoff or installed runtime refuses continuation. This reuses the prior observation; it does not claim a new browser ceremony.
3. Install the exact public correction source on this existing host. Transfer **50** protected runtime/database/signing/TLS/CA/ACME/configuration files over pinned SSH. Exclude only `initial-issuance.log`; retain that original backup unchanged. The manifest is `f5b1a5faad65d47219e89c4de4abae24be8f299a4dedfbb5a5b034b7bc5dae51`. The complete payload passes the corrected receiver and seven-file ACME/runtime-pair validation in local memory without private file copies. Receiver validation completes before any directory creation; missing release parents are then created with mode 700 and files with mode 600.
4. Run reviewed bootstrap/networking and cache the same six pinned images. Install existing certificate/recovery maintenance state with timers disabled. No new certificate account or credential rotation is requested.
5. Verify all three current staging databases read-only using the existing migration images/checkers. Start the same eight pinned runtime services in maintenance. Verify new container identities, readiness and five TLS/auth boundaries. Keep the existing candidate `p1-41541683416-1` and frontend deployment `dpl_CdhFqwVANweysVe9cCTNpmHfduiy`.
6. Preserve C2 receipts unchanged. Return only allowlisted technical JSON receipts to `/Users/dardan/.local/share/lash-her/recreations/staging/p1-recreate-access-20261103-c3`, outside Git, mode 700 directories/mode 600 files. Stop for review on failure; do not overwrite or retry a partial action.

No AWS mutation, stop, host replacement, new snapshot, migration application, database restore, business fixture writes, raw business-row export, frontend build/promotion, production change, business schedule activation or gateway write admission is included. Maintenance timers stay disabled. Successful runtime restoration does not close the remaining live rollback, lease/retry recovery, boundary qualification or P1/G1 acceptance requirements. Failure can prolong staging unavailability.

## Validation and explicit start

The component evidence, actual payload check, actual read-only host/snapshot preflight, committed-source plan and exact-source CI proof are recorded beside this runbook in `baselines/2026-11-03-existing-runtime-*`. A missing or failed check does not authorize execution.

Public-only settings are saved outside Git with mode 600, using this correction's exact 40-character committed source:

```json
{
  "version": 4,
  "action": "p1-recreate-access-20261103-c3",
  "continuationOf": "p1-recreate-access-20261103-c2",
  "sourceCommit": "EXACT_COMMITTED_CORRECTION_SOURCE",
  "operatorIpv4Cidr": "99.239.187.88/32"
}
```

From that clean checkout, `node ops/platform/cold-recover-staging.mjs plan /absolute/private/settings.json` performs local planning only. After all ten exact-source CI jobs pass and Dardan explicitly starts C3, run `node ops/platform/cold-recover-staging.mjs apply /absolute/private/settings.json --confirm staging/p1-recreate-access-20261103-c3` once.

The [accepted release policy](release-policy.md) states: “Dardan reviews failures before a deliberate retry.” C3 changes the failed receiver source and narrows the private handoff to 50 files; C2's approval does not start this retry. No new operator credentials or arbitrary approval expiry are introduced.
