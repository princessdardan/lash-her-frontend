# Operator migration command

The [single-operator release policy](release-policy.md) uses the operator migration images and `ops/platform/host/migrate.py`. The frontend now has a [packaged component](operator-frontend-migrations.md) alongside the two APIs. They are implemented and tested locally. A live staging run still needs committed/qualified images, reviewed current target lineage, private migration credentials and recovery information. No signing key, external executor or GitHub approval environment is needed.

## Routine use

The release operator works from one reviewed candidate and one environment target file. Bundle assembly derives commit/image/SQL bindings automatically; no detached approval document is hand-written.

1. Obtain the successful candidate and its CI evidence through the authenticated GitHub CLI. Download each private API's `operator-schema-postgres18` artifact from the exact passing `ciRunId` in `source-checks.json`, into `SCHEMAS/course` and `SCHEMAS/community`. Keep these schema exports private; they contain structural function definitions. Use a matching-major export for any other database major. Native provenance, scans and CI receipts must belong to the selected source/images; format-valid JSON alone does not prove this.
2. Prepare the reviewed target file from current provider mapping and read-only lineage. For each service include the exact direct host/port/database/migration role, runtime role, PostgreSQL major, reviewed ordered `approvedPendingTags`, explicit `allowEmptyBootstrap`, provider identity reference and recovery reference. Do not include URLs, passwords or tokens. Preserve Course 0014's existing freeze/backfill precautions. This target file is maintained configuration, not a new trust service.
3. Prepare and inspect the migration bundle:

   ```sh
   node ops/platform/prepare-migrations.mjs CANDIDATE_JSON TARGETS_JSON SCHEMAS BUNDLE
   python3 ops/platform/host/migrate.py BUNDLE RESULTS
   ```

   `BUNDLE` must be new and outside Git checkouts; the preparer refuses checkout output to keep private API schemas out of the public frontend repository. `RESULTS` is a private mode0700 directory outside Git checkouts as well. Preparation/checking acquires no credential and contacts no database. The host plan shows the environment, database identities, images and pending migrations. Every selected image CLI performs its own source/schema/target input checks before any database operation during apply. New candidates include the frontend image and require maintained `frontend` target settings. A full three-database bundle is plan-ready; apply additionally requires the unfinished frontend quiescence/deployment coordinator. The standalone host CLI cannot assert off-host writer/scheduler suspension or bypass that hold.
4. Dardan starts the reviewed staging action with private runtime injection. Replace the reference names below with the actual approved migration-secret names; these are placeholders, not created resources:

   ```sh
   COURSE_STAGING_DATABASE_URL='{{resolve:secretsmanager:REPLACE_WITH_COURSE_MIGRATION_SECRET:SecretString:url}}' \
   COMMUNITY_STAGING_DATABASE_URL='{{resolve:secretsmanager:REPLACE_WITH_COMMUNITY_MIGRATION_SECRET:SecretString:url}}' \
   asm-exec -- python3 ops/platform/host/migrate.py BUNDLE RESULTS --apply --confirm staging/RELEASE_ID
   ```

   Values resolve privately in the wrapper/child processes. The script gives each nonroot container only its selected named URL, never the other service's credential or ambient AWS credentials. Registry authentication remains outside the container. Do not put a URL in an argument or log.

## Execution and failure behavior

The host wrapper takes the shared `/run/lock/lash-her-release.lock` used by the watchdog. On a Mac it uses a private per-user temporary lock for local operation; this does not replace the deployment host's coordination when operating remotely. Database advisory locks independently serialize runners across machines.

After validating both jobs and confirming both credentials are available, the wrapper suspends the selected Compose project's runtime containers and confirms no writers remain. This migration command is a maintenance step. It leaves the runtime stopped, including after success; runtime deployment/readiness and traffic admission must follow through the release procedure. The [frontend migration component](operator-frontend-migrations.md) now uses its own reviewed source/SQL/schema-bound operator command and must be coordinated in the same release. The wrapper can include the packaged frontend migrator under the same lock; it refuses a full bundle until a reviewed in-process coordinator verifies frontend producer suspension. The standalone API-only maintenance command is not complete release orchestration. Use the [API runtime coordinator](operator-runtime-release.md) instead when the same action should perform API migrations and runtime startup under one host lock.

Each API holds one verified-TLS physical session and database lock across complete lineage verification, reviewed forward apply, exact schema-catalog comparison, role/grant isolation checks and receipt recording. Ordinary Node PostgreSQL TLS configuration is used; channel binding is enabled when offered. No native libpq build/enrollment is required. [PostgreSQL client TLS behavior](https://node-postgres.com/features/ssl).

An existing result directory is never overwritten. Failed or interrupted migrations stop rollout and preserve the outcome and failure phase. Check the actual journal and receipt before a deliberate retry with a fresh private results directory; there is no automatic retry or down migration. Failed Docker commands trigger container removal and an explicit absence check. A missing/failed cleanup result cannot qualify success. The in-container deadline is twenty minutes, with statement/DDL lock timeouts; termination never implies that a late database outcome was safe or that traffic may resume.

`database-receipt.json` is written under the database lock. `job-outcome.json` reports completion after cleanup. `migration-outcome.json` binds the overall result and receipt hashes. Treat `FAILED_REQUIRES_REVIEW`, missing records or mismatched identities as failure. Retain the result directory and candidate off-host using existing storage. No receipt is an independent signature or credential.

## Production

Use the same command with production configuration and `--confirm production/RELEASE_ID`. Production credentials use `COURSE_PROD_DATABASE_URL` / `COMMUNITY_PROD_DATABASE_URL` in the runtime wrapper; the containers receive only `PROD_DATABASE_URL` plus the explicit target.

Bundle preparation additionally takes a reviewed `STAGING_EVIDENCE` directory as its fifth argument. It contains the successful staging `acceptance.json`, both API database/job receipts, and current production `recovery.json`. The host checks the same source/image/SQL identities, successful application/OIDC/worker/lineage checks, and production backup/restore references matching the selected targets. Real staging acceptance and a current recovery review must exist; writing success labels into a file is insufficient evidence. Production remains blocked until these live controls are actually verified.

## Verification scope

Both API suites and isolated PostgreSQL16/18 rehearsals exercise the new command. PostgreSQL18 tests execute the actual packaged migration CLI and compare its compiled code with the test build. The owned tests cover fresh installs, populated upgrades with retained business/audit data, current-chain no-op, concurrent lock refusal, wrong certificate/role, changed lineage, schema drift, runtime DDL/journal isolation and fixture production promotion.

CI exports the matching schema baseline from that owned cluster only after success. It accepts no external database URL and uses no live credential. Runtime images exclude the migration module; migration images exclude application entrypoints and test tools. The host wrapper's control-flow/credential/cleanup checks currently have mocked Docker coverage; actual host maintenance, remote publication and provider execution remain unverified.
