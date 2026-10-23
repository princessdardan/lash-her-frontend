# P1-02 staging runtime and release-store handoff

The requested Community runtime role and protected staging DB handoff are
complete. Remaining provider configuration is prepared. P1-02 remains **BLOCKED**
on the separate release/provisioning/provider/deployed-evidence gates below.
[Sanitized evidence](2026-10-22-p1-02-release-handoff.json) records actual resources
and checks. No application deployment or cloud application migration ran.

## Applied and verified

- Created `lash_her_community_staging_runtime` in Community Neon project
  `still-darkness-27201043`. Pooled runtime login uses independent credentials;
  direct `neondb_owner` credentials remain migration-only. No public-schema CREATE,
  privileged memberships, superuser/create-db/create-role/replication/RLS-bypass.
  DML and sequence grants apply to existing tables and future owner-created tables.
  The cloud database still has zero public tables and no migration journal.
- After Dardan selected AWS Secrets Manager, provisioned stack
  `lash-her-staging-release-store` in `691588646557/us-east-1`: dedicated rotating
  KMS key, three secrets and three resource policies. Imported Community runtime,
  Community migration and frontend migration values from mode-0600 private files.
- All records passed `asm-exec` protected resolution followed by a read-only TLS 1.3
  database connection with certificate verification. No values entered output or
  repository files. Current import version IDs and encryption/access policies
  were read back through metadata APIs.
- Value-read policies admit only the existing operator and account-root break-glass
  access. CI/hosts have no access; the deployment role is unchanged. All seven
  resources are retained. Stack termination protection and key/secret update
  replacement/deletion guards are enabled. Stack is `UPDATE_COMPLETE`.
- The private import receipt preserves per-record UUIDs for retries. Initial
  post-write metadata verification required a retry; the saved tokens were reused
  and final current versions verified. The importer now retries propagation checks.
  It never retrieves a cloud secret value.

[Release-store runbook](../../../ops/staging/release-store.md),
[public resource/version metadata](../../../ops/staging/release-store.json),
[CloudFormation](../../../ops/aws/staging-release-store.cfn.json) and
[unattached read-policy plans](../../../ops/staging/access-policies/) make the
handoff reviewable. Future consumers still require reviewed identity/resource/KMS
permissions; a prepared identity policy alone cannot bypass the explicit deny.

## Provider preparation and remaining inputs

[Provider plan](../../../ops/staging/providers.md) and
[request configuration](../../../ops/staging/providers.json) specify exact Google
Identity/Calendar callbacks and scopes, disabled Square sandbox/Sanity registrations,
Resend contact event/disable plans and isolated Mux inputs. No request was activated,
no webhook registered, no email or provider event sent.

Required inputs remain dedicated Google clients/test identities/calendars, reviewed
admin/sender/recipient identities, isolated Resend contact account or reviewed
implemented disabled workflows, provider registration/signature keys and Mux
credentials/Course gateway origin. A sending-only Resend key cannot run the current
contact/segment/campaign worker. Production account-wide credentials cannot close
that isolation gap.

All-deployment Vercel Authentication also requires a reviewed provider ingress
method before callbacks can operate. Automation bypass is project-wide and skips
some firewall/bot checks. No bypass credential or protection exception was created.
The plan records signature/URL consistency and access/logging considerations.

## Verification and limits

- 15 private-import field/identity/TLS/isolation tests and four release-preflight
  tests passed under Node 24.18.0; changed-file ESLint passed.
- A disposable local PostgreSQL 18 integration test verified owner-created future
  table/default privileges, runtime DML and identity sequences. Seven DDL/privilege
  operations were rejected with SQLSTATE 42501. The container was removed.
- `cfn-lint` 1.58.0, AWS template validation and all four `cfn-guard` 3.2.1 rules
  passed. Six negative fixtures were rejected, including removal of retained access
  policies. Live stack/key/policy/current-version metadata passed verification.
- No Next build or full application suite was repeated for this ops-only work.
  Earlier application compatibility tests remain scoped to the earlier uncommitted
  candidate and do not certify a deployed release.

The initial full-month storage estimate is USD 2.20: three secrets at USD 0.40 each
and one KMS key at USD 1, plus usage/tax/FX. The first two future KMS rotations each
add USD 1/month. Retained resources keep billing. Sources and caveats are in the
resource metadata; this does not complete the overall operating-cost budget.
[AWS Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/),
[AWS KMS pricing](https://aws.amazon.com/kms/pricing/) checked 2026-10-22.

CloudTrail event history shows the staging writes, but no persistent trail was
found or created. Long-term audit retention/access alerts and a reviewed Neon
credential-rotation owner/cadence/workflow remain operations work. KMS key rotation
alone does not rotate a Neon password.

Reviewed source/artifact pins, protected migrations with target/lineage/lock
controls, CI/host trust, host/operator/private TLS/recovery, complete costs and
deployed OIDC/provider/scheduler/smoke evidence remain open. Changes are uncommitted;
unrelated existing working-tree edits were preserved.
