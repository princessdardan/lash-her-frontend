# Frontend operator migrations

This is the frontend database component of the [single-operator release](release-policy.md). It uses the existing SQL and audited lineage rules, without a signing service or separate reviewer. It is locally verified; frontend deployment, promotion and final traffic admission are not yet connected to the host coordinator. Do not treat this command's success as release acceptance or resume traffic from its receipt alone.

## Prepare once for the selected candidate

1. Select the exact passing source candidate. Its `frontendMigration` field binds the commit, contract, ordered SQL and PostgreSQL-major schema digest from the exact source CI run. CI publishes only a digest summary from its owned PostgreSQL18 rehearsal; it publishes no private schema definitions or credentials.
2. Reproduce the schema export privately from that clean source, using the owned fixture in `ops/platform/test-frontend-migration-local.mjs` with `FRONTEND_MIGRATION_EXPORT_SCHEMA=true`. Use the PostgreSQL18 test container and read-only mounts shown in `.github/workflows/ci.yml`, redirecting output outside Git. Store it as `SCHEMAS/frontend/operator-schema-postgres18.json`. Preparation refuses a schema digest different from the candidate's CI digest. PostgreSQL16 also has local compatibility coverage; it needs its own qualified CI baseline before a release can select it.
3. Add `frontend` to the maintained target settings: `host`, `port`, `database`, migration `user`, distinct `runtimeRole`, `serverMajor`, `approvedPendingTags`, `allowEmptyBootstrap`, and `recoveryRef`. Use the verified direct provider endpoint. Review the complete current journal, pending SQL and recovery reference. Include no credential value. The migration role must own the migrated schema objects; the runtime role needs public usage, table CRUD and sequence usage/select, including default grants, and no schema/database creation, object ownership, elevated flags or migration-role membership.
4. Run the existing bundle preparer:

   ```sh
   node ops/platform/prepare-migrations.mjs CANDIDATE_JSON TARGETS_JSON SCHEMAS BUNDLE
   node ops/platform/frontend-migration.mjs --check BUNDLE/release.candidate.json BUNDLE/jobs/frontend.json BUNDLE/schema/frontend.json
   ```

   `BUNDLE` is a new private directory outside Git. Preparation and `--check` read no credential and open no database. They do not authorize migration. Production preparation takes the existing `STAGING_EVIDENCE` fifth argument and the successful frontend staging database/terminal receipts in its `frontend` subdirectory.

## Apply within the operator release

Keep affected producers suspended and hold the environment's release lock across this component and dependent deployment. The database advisory lock independently prevents concurrent migration from another machine. The API host coordinator currently handles only API migrations/runtime startup; running the frontend command separately does not establish a shared host lock.

Create a new private mode0700 result directory outside Git. Resolve the named URL privately at runtime, then execute the exact prepared inputs with Node24:

```sh
node ops/platform/frontend-migration.mjs --execute BUNDLE/release.candidate.json BUNDLE/jobs/frontend.json BUNDLE/schema/frontend.json --confirm staging/RELEASE_ID RESULTS/frontend
```

Supply `FRONTEND_STAGING_MIGRATION_DATABASE_URL` through the existing private runtime credential mechanism. For production use `FRONTEND_PROD_MIGRATION_DATABASE_URL` and `--confirm production/RELEASE_ID`. Never place connection strings in arguments, source, receipts or chat. AWS references resolve through `asm-exec`; no new secret store or executor is required. This CLI loads no dotenv file and accepts no ambient `DATABASE_URL` fallback. It verifies exact connection identity and certificate-verified TLS.

The runner requires a clean checkout at the candidate commit before acquiring the credential. It retains one physical connection and advisory lock through complete lineage preflight, the reviewed ordered forward migrations, schema/grant verification and the durable database receipt. Each SQL migration commits separately for PostgreSQL enum compatibility. An explicit empty bootstrap refuses unjournaled application tables. Normal releases do not edit applied SQL/journals, run down migrations, or use tests, seeds or schema push against release databases.

`database-receipt.json` is written before unlocking. `job-outcome.json` qualifies completion only after cleanup; both must match. The output directory is exclusive and cannot overwrite an earlier attempt. Any failure, missing receipt, interruption or uncertain cleanup stops rollout and requires state reconciliation before a deliberate retry. Receipts remain `trafficAuthorized: false`. Retain them inside the ordinary release evidence, not a separate approval ledger.

Production additionally requires matching successful staging receipts for the same source, SQL, contract and schema, plus the parent release's actual staging acceptance and current production recovery checks. Synthetic owned-cluster promotion is test coverage only.

## Existing commands

`npm run db:check -- --env-file <protected-env-file>` remains read-only. `npm run db:migrate` now supports only explicitly selected isolated loopback local databases. It refuses staging, production and remote hosts labelled local. The old protected staging entrypoint is retired and always refuses execution. These paths cannot substitute for the operator release.
