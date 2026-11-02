# Cross-repository migration policy

Effective November 1, 2026 under the [single-operator release policy](release-policy.md). This supersedes the earlier protected-job/external signed-executor procedure, including the Course staging bootstrap signing requirement. Frontend, Course and Community keep separate database ownership, migration history and credentials.

## Release path

Dardan initiates one reviewed release command for an explicit staging or production target. That command is the approved release job and may run on Dardan's authenticated Mac or the deployment host. No separate signing authority, external executor service, GitHub approval environment, cloud federation or independent reviewer is mandatory. Never use ad hoc SQL, an application startup hook, schema push, test/seed commands or direct release-target Drizzle Kit writes as substitutes.

The command must:

1. Select committed, CI-verified source and immutable migration/runtime artifacts; review the pending ordered SQL chain. Production reuses the artifacts that passed staging.
2. Match the exact provider/project/branch, host, database and migration role against the intended environment. Never infer the target from a variable name. Use direct, certificate-verified TLS connections and narrowly scoped migration credentials, resolved privately at runtime. Keep runtime and migration credentials separate. Native SCRAM channel binding may be retained where supported; bespoke native transport attestation is not a separate enrollment gate.
3. Confirm recovery appropriate to the target. For production, record a usable backup/PITR point and a still-applicable restore rehearsal before applying changes.
4. Hold one environment release lock and a database advisory lock for the entire lineage preflight, forward migration, schema/journal verification and receipt. Compare the complete applied journal to the artifact's ordered hashes; refuse gaps, unknown/changed entries and unexpected pending SQL. A read-only preflight alone cannot authorize a later unlocked apply.
5. Apply only the reviewed pending forward migrations once, before dependent code. Keep required write freezes/publishers suspended through backfills. Stop rollout on failure and reconcile actual state before a deliberate retry; no automatic rerun of an uncertain migration.
6. Save one sanitized receipt containing the release, environment, operator, target identities, SQL/artifact hashes, pre/post lineage, migration outcome, recovery reference and smoke results. Reuse the release receipt rather than maintaining parallel approval ledgers.

## Target selection and existing tooling

| Repository | Staging | Production | Existing enforcement |
| --- | --- | --- | --- |
| Frontend | `FRONTEND_STAGING_MIGRATION_DATABASE_URL` | `FRONTEND_PROD_MIGRATION_DATABASE_URL` | [Operator frontend CLI](operator-frontend-migrations.md): exact source/SQL/schema/target, TLS, complete lineage, one locked session and separate database/terminal receipts. `db:migrate` is local only. |
| Course | `DATABASE_TARGET=staging`, `STAGING_DATABASE_URL` | `DATABASE_TARGET=prod`, `PROD_DATABASE_URL` | Locked core, separate image and operator entrypoint implemented/tested locally; live staging verification pending. Direct Drizzle release writes remain refused. |
| Community | `DATABASE_TARGET=staging`, `STAGING_DATABASE_URL` | `DATABASE_TARGET=production`, `PROD_DATABASE_URL` | Same operator/core/image status; live staging verification pending. Direct Drizzle release writes remain refused. |

Run Node24 from the owning repository. Named environment URLs are mandatory for API releases; no legacy URL fallback or `.env` inclusion in artifacts. Source-only `db:lineage:check -- --manifest-only` and read-only target preflights remain inspection, not apply authorization. Explicit target/host confirmation is retained as an accident-prevention guard, not claimed as independent approval.

## Safety and recovery

Tests, seed operations and destructive round-trip tooling run only against isolated disposable local databases. Never point them at staging or production. Preserve applied SQL, journals, snapshots and business/audit history; carry changes in new forward migrations. P0-04's accepted provenance review remains valid within its recorded scope; obtain fresh deployed lineage before applying.

Keep PostgreSQL-version compatibility tests and data-bearing upgrade coverage for affected migrations. Retain Course 0014's backfill/write-freeze and UUID/collision precautions. Restore a compatible application release or roll forward on failure. A database restore is an incident recovery operation requiring reconciliation of subsequent payment/events history, not routine rollback.

## What remains to implement

The [operator migration command](operator-migrations.md) now reuses both API locked cores, with locally tested CLIs/images, private credential isolation, bundle preparation and the host release lock. PostgreSQL16/18 owned rehearsals pass; actual host maintenance, artifact publication and provider staging verification remain. The [frontend operator component](operator-frontend-migrations.md) is now locally verified on PostgreSQL16/18, with its CI SQL/schema digest binding. Joining it to frontend deployment/promotion and final admission under the release lock remains open. Production integration migrations remain blocked until actual staging acceptance and current production target/recovery checks exist; no signing-key or external-executor setup is needed.

The old Course signed-bootstrap workflow/compiled guards remain disabled as a retired prototype. Do not enroll its root or bypass it. Its historical synthetic evidence is not evidence that the replacement has run. This policy authorizes a simpler design, not a live migration or credential change. See [the current release policy](release-policy.md) for production promotion and credential boundaries.
