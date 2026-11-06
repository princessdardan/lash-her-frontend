# Single-operator release policy

Accepted November 1, 2026; clarified November 2. Dardan is the sole developer and operator. This is the authoritative staging and production release policy. It supersedes the external signed source gate, separate external migration executor and October 29 Course bootstrap signing requirement. Earlier evidence remains historical.

## Staging: review, release, verify

1. **Review one candidate.** Select the exact committed frontend, Course and Community revisions with passing required CI. The candidate workflow builds and checks immutable API, gateway and migration images and records their source and contract identities. Reuse that candidate for deployment; never select `latest`.
2. **Start the staging release.** Review the displayed staging targets, changes and pending migrations, then explicitly start the reviewed release command. This action is Dardan's deployment approval. Use staging-only databases, credentials and safe provider settings. Candidate publication is build-only and does not itself authorize deployment.
3. **Check the result.** The release tooling applies pending migrations, deploys in dependency order, checks readiness/authentication and affected workers or scheduled jobs, then admits dependent traffic. It records the outcome and previous working release in one sanitized release record. Dardan reviews failures before a deliberate retry.

Disposable staging may be recreated after its producers are suspended. Tests that create or drop schemas use disposable local databases, never the staging database.

## Production: promote the tested candidate

Use the same procedure with these checks included in the production action:

1. **Staging passed.** Promote the exact staging-tested API, gateway and migration image digests and source revisions. Changed artifacts return through staging. Build the frontend from that source with production configuration and verify the deployment before assigning production domains.
2. **Recovery is available.** Confirm a usable backup/PITR point for affected databases and retain the previous compatible application/configuration release. Review pending SQL and any required maintenance window.
3. **Production is explicit.** Display the production target identities and recovery reference before Dardan starts the production action. This is the production approval; staging approval does not carry over.

Prefer backward-compatible forward migrations. Pause affected writers when a migration or backfill requires it. If a release fails, stop dependent traffic and inspect actual state; use a compatible application rollback or a reviewed forward fix. Destructive/data-loss migrations need a specific reviewed plan. Database restores require reconciliation of subsequent payments/events and are incident recovery, not routine deployment rollback.

## Initial qualification versus routine releases

Initial P1 staging qualification still proves real workload OIDC/TLS, host isolation, native scheduling/cancellation, recreation, recovery and compatible rollback. A local test or policy amendment cannot substitute for those live checks.

Routine releases reuse applicable qualification evidence. Repeat the affected checks when changes to schema, infrastructure, scheduling, authentication, providers or recovery invalidate it, or when a failure raises doubt. Do not repeat full host recreation, restore rehearsals or account inventories merely because a release is new. Required source CI and release smoke checks still run for each candidate/release.

## Automatic safeguards

The tooling displays the release ID, images, host/project and database host/name before apply. It owns exact environment/target checks, artifact/contract verification, native provenance/SBOM/image scans, TLS, complete migration lineage, database advisory locks and the host release/watchdog lock. It uses environment-scoped runtime credentials, keeps migration and application roles separate, and stops on failure. CI tests have no staging/production database access. Application startup, tests, seeds, schema push and ad hoc SQL are prohibited migration paths for staging/production.

Keep one release record off-host with the manifest and previous configuration using existing storage. It may reference generated CI, migration and smoke results; Dardan need not duplicate them in approval forms or maintain a separate ledger. Records contain no credentials or private schema exports.

## Setup and maintenance

- Frontend `main` and `staging` advances do not automatically deploy. Source-controlled `git.deploymentEnabled` disables Git-triggered builds on those two release branches; reviewed API/CLI deployment and promotion remain part of the explicit release action. Feature-branch preview behavior is unchanged. This setting does not cancel builds already running or suspend native schedules. See [Vercel Git configuration](https://vercel.com/docs/project-configuration/git-configuration).
- Keep the current GitHub plan and private API repositories. Use normal authenticated accounts/MFA and branch protection where available. Unavailable protection is recorded; it does not require a subscription upgrade.
- Reuse the existing secret store. The [source publication runbook](../../ops/platform/source-gate.md) documents the single read-only cross-repository credential and its three storage locations; no new identity service is required. Registry publication uses the workflow's repository-scoped token. Keep deployment and database access scoped to the selected environment and resolve AWS-held values privately at runtime through `asm-exec` references.
- No second reviewer, independent signer, key-enrollment ceremony, per-run signed permit, mandatory GitHub App/approval environment, separately hosted executor or additional approval click is required. Approval has no arbitrary short expiry; changed artifacts, targets or migration plans require a fresh review/action.
- Billing access, spending reports and budget-headroom evidence remain excluded. Affordability guides design; Dardan manages the US$50 monthly target. Monitoring and alerting remain deferred until after the integration plan.

This policy trusts Dardan's authenticated account and reviewed tooling. It provides no independent human review or protection against compromise of that account.

## Implementation boundary

Source/candidate checks, immutable artifact preparation and the [operator migration](operator-migrations.md), [API runtime](operator-runtime-release.md) and [frontend migration](operator-frontend-migrations.md) components are implemented and tested within their recorded scope. An already-current frontend uses a verified read-only database stage before API migrations, without requiring frontend suspension. Pending frontend SQL still refuses standalone full-bundle apply until the reviewed coordinator establishes writer/scheduler suspension.

The [initial staging qualification coordinator](operator-staging-qualification.md) joins the already-current frontend database stage, API migrations/startup, automatic expiring workload probe, frontend build and verified staging domain promotion under one lock. It preserves native schedule suspension and gateway maintenance. Accepted recovery-only G1, including its native scheduler/host/recovery and final admission evidence, is recorded in the [current checkpoint](current-state.md). Reuse that evidence within its exact scope; later Phase 2 features require their own affected qualification.

The [Phase 2 operator driver](operator-p2-release.md) and same-action role preparation are source implemented with owned PostgreSQL and process-failure evidence. Exact integrated-source Linux/candidate qualification and complete current-only recovery remain open. Historical/provider joins cover source-proven inapplicability; [configured scopes still require missing reducers and actual evidence](p2-historical-provider-live-gates.md). Legacy staging commands still refuse pending frontend SQL. The [prepared P2 certification matrix](p2-staging-certification.md) records the remaining source, candidate and deployed requirements. The one-action procedure above remains required; this implementation status supplies no release approval. Production orchestration remains outside the Phase 2 goal.

The retired Course signed-bootstrap prototype stays disabled; its enrollment or activation is unnecessary. This status reconciliation changes no approval rule, deployed state, provider setting or credential handoff. Dardan must start the concrete reviewed staging release after the new candidate and its prerequisites are qualified.
