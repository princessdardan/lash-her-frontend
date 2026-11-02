# Single-operator staging and production releases

Effective November 1, 2026, by Dardan's request to simplify both policies. Dardan is the sole developer and operator. This document supersedes the external signed source gate and the separate external migration-executor requirement, including the October 29 Course bootstrap exception. Earlier dated evidence remains historical. A policy change does not certify or activate a deployment.

## Common procedure

1. **Select the release.** Review the changes and select exact committed revisions in all three repositories. Require passing CI for those revisions: type/lint/unit, contract drift, isolated database/migration tests, image scans and the integration harness. Publish one candidate containing immutable API/gateway/migration image digests and the contract hash. Never deploy a mutable tag such as `latest`.
2. **Select the environment.** Use the dedicated staging or production host, Vercel project, databases and provider configuration. Display the intended environment, database host/name, release ID and images before applying changes. Secrets come from that environment's existing secret store, privately at runtime. CI tests have no staging/production database access.
3. **Run one release command.** Dardan explicitly starts the release for that environment. This is the approval; no second person, separate signing operation or second environment-review click is required. The command may run on Dardan's authenticated Mac or the deployment host. It must be a reviewed release entrypoint using the pinned artifacts, not ad hoc SQL or a direct Drizzle invocation. Serialize releases and watchdog/update operations with the existing host lock. Each database migrator holds its database advisory lock across lineage preflight, forward apply and postflight.
4. **Verify and record.** Deploy in dependency order, check readiness, authentication and worker/scheduled behavior, then admit dependent traffic. Save one sanitized release receipt with operator, environment, source commits, image digests, target identities, migration result, checks and previous working release. Retain it with the previous manifest/configuration off-host, using existing storage. A failure stops rollout and dependent traffic; reconcile state before a deliberate retry.

No additional release service or dedicated executor fleet is required. A manually invoked release script is a release job for this policy. Application startup, tests, seeds, schema push and destructive round trips remain prohibited migration paths for staging/production.

## Staging

Use staging-only databases, credentials and safe provider settings. A reproducible rebuild, migration/lineage verification, authenticated smoke checks and a recovery rehearsal qualify the candidate. Disposable staging may be recreated after its producers are suspended. Tests that create/drop schemas still use disposable local databases, never staging.

The manual artifact workflow is build/publish only. Its dispatch approves the exact source candidate; it does not grant cloud access or approve deployment. Real gateway workload OIDC, TLS and application authorization still need their deployed checks. Removing release-signing OIDC does not change gateway authentication.

## Production

Use the same procedure with three additional checks in the same release action:

- **Staging passed:** promote the exact API/gateway/migration digests and source revisions already exercised in staging. Changed artifacts go through staging again. Build the frontend separately with production configuration from the reviewed source; validate the unaliased production deployment before assigning production domains.
- **Recovery is available:** confirm a current usable backup/PITR point for each affected database and retain the last compatible application/configuration release. Reuse the documented restore rehearsal while it remains applicable; repeat it when schema, recovery configuration or the recovery method changes, not as a ritual for every release.
- **Production is explicit:** show production target identities, pending migrations, recovery reference and any maintenance window before Dardan starts the production action. Staging approval never implies production approval. Approval has no arbitrary short expiry or detached permit; a changed target, artifact or migration plan needs a new review/action.

Prefer backward-compatible forward migrations and compatible application rollback. Destructive/data-loss migrations require a separately reviewed data-migration plan; down scripts and silent journal edits are never routine rollback. Keep sales/affected writes paused if correctness is uncertain while preserving payment reconciliation.

## Minimal account setup

- Keep the current GitHub subscription and private API repositories. Use normal authentication/MFA and native branch protection where available; unavailable protection is recorded, not a release blocker. Do not require a second reviewer or prohibit self-approval.
- The prepared cross-repository artifact workflow needs **one read-only source credential**, stored as frontend repository Actions secret `PLATFORM_SOURCE_READ_TOKEN`. A fine-grained token scoped to the three named repositories with Contents read, Actions read and automatic Metadata read is sufficient. Give it an expiry and replace it when needed. Do not broaden it to package/cloud/database access. A GitHub App is an optional future alternative, not setup work required now. [GitHub authentication options](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token), [fine-grained token permissions](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
- Registry publication uses the workflow's repository-scoped `GITHUB_TOKEN`. Preserve private API image visibility. Deployment and migration credentials remain separate, scoped by service/environment, and are never pasted into chat or committed. AWS secret values resolve with `asm-exec` references at runtime.
- No `platform-artifacts` environment, App registration, external approval key, key fingerprint/custody enrollment, source identity probe, per-run signed envelope or separately hosted executor is required. Existing settings need not be deleted to adopt this policy.

The tradeoff is explicit: release approval trusts Dardan's authenticated account and reviewed release tooling. It does not independently resist compromise of that account or provide independent human review. No custom signature system is maintained to claim otherwise.

## Implementation status

The simplified artifact workflow and manifest checks are implemented locally. Source checks use GitHub's authenticated API; the recorded receipt is not a signature or standalone authorization token. Native artifact provenance/SBOM/scan checks remain automated.

The [operator migration entrypoints, host wrapper and bundle preparer](operator-migrations.md) now reuse both API locked cores and pass local PostgreSQL16/18 rehearsals. The [API runtime coordinator](operator-runtime-release.md) now adds locally verified configuration preflight, dependency ordering and failure suspension under the same release lock. The [frontend operator migration component](operator-frontend-migrations.md) now has locally verified PostgreSQL16/18 coverage and CI-bound SQL/schema identities. Actual host execution, frontend deployment/promotion coordination, final traffic admission and real staging verification remain open. The old Course signed-bootstrap workflow and compiled activation holds remain disabled as a retired prototype; enrolling its keys, verifying an external executor or enabling that workflow is no longer a prerequisite. Do not flip its guards to obtain a migration path. Keep ordinary target/TLS/lineage/lock/test/seed guards intact in the replacement.

This revision does not provision a host, publish source or images, issue credentials, run a migration, activate delivery or approve production sales. Billing evidence remains excluded and monitoring remains deferred under the earlier decisions.
