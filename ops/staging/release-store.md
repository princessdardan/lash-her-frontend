# Protected staging release-store handoff

The selected AWS store is provisioned and initialized in account `691588646557`,
region `us-east-1`. [release-store.json](release-store.json) records the actual
stack/key/secret ARNs, current version IDs and metadata verification. It contains
no connection strings or passwords. The user explicitly selected this billable,
operator-only store; no CI or host permission was added.

| Record | Consumer | Connection and application fields |
| --- | --- | --- |
| `lash-her/staging/community/runtime` | Future Community API/approved workers only | Pooled `still-darkness-27201043`, role `lash_her_community_staging_runtime`; `DATABASE_TARGET=staging`, `STAGING_DATABASE_URL` |
| `lash-her/staging/community/migration` | Protected Community migration job only | Direct endpoint, `neondb_owner`; `DATABASE_TARGET=staging`, `STAGING_DATABASE_URL` |
| `lash-her/staging/frontend/migration` | Protected frontend migration job only | Direct `morning-tree-37564896`, `neondb_owner`; `DATABASE_URL`, `PRIVATE_DB_MIGRATION_TARGET=staging`, exact `PRIVATE_DB_MIGRATION_HOST` |

Each JSON record also carries PostgreSQL host/port/dbname/username/password fields.
All connection URLs enforce certificate verification (`sslmode=verify-full`). The
runtime record contains no owner credential. Frontend runtime continues to receive
only its existing separate restricted pooled URL in Vercel. Community has no
frontend binding. Course credentials were not imported into this store.

## Access and infrastructure

[CloudFormation](../aws/staging-release-store.cfn.json) creates one dedicated
symmetric KMS key, three secrets and three secret resource policies. The key has
automatic KMS key rotation enabled. Its cryptographic operations are restricted
to these three secret encryption contexts through regional Secrets Manager.
Secret value reads are explicitly denied to principals other than the existing
release operator `arn:aws:iam::691588646557:user/Dardan` and account-root break-glass
access. This controls value reads; the existing administrator retains policy
administration authority.

All seven resources have retention policies, so retained secret access policies
remain attached if stack deletion is later authorized. Stack termination
protection is enabled; a stack policy denies deletion/replacement of the key and
three secrets during updates. These controls require explicit operator changes
for teardown. Retained resources continue billing. Do not delete the key while
any credential record still depends on it.

The AWS MCP deployment role lacks the required secret-store permissions. Setup
used the existing administrator-controlled login through the official AWS JS SDK,
with identity/account checks. A temporary private SDK profile alias worked around
its parser skipping the user's existing quoted profile name. The user's AWS
configuration and deployment-role permissions were not changed. SDK packages
`3.1156.0` were installed in a private temporary tools directory, not application
dependencies.

[Exact-record read policies](access-policies/) are prepared, **unattached**.
Attaching one alone does not grant a new reader: the secret resource policy still
explicitly denies that principal. Before any CI or host handoff, separately review
its identity/trust, exact secret needs, resource-policy allowlist, KMS conditions,
process isolation and expiration/rotation. No migration-owner secret may be
installed in a long-running application process.

## Private import and verification

`import-release-secrets.mjs` accepts the private Community owner/runtime files and
initial staging Vercel snapshot. It verifies pinned project/host/role/database/TLS
identities, selects only the required DB fields and rejects runtime/owner password
reuse. Private files must be regular owner-controlled files without group/other
permissions. Values and SDK error details are withheld from output.

Inspect the prepared payload shape without writing:

```sh
node ops/staging/import-release-secrets.mjs \
  --private-dir /private/tmp/lash-her-p1-02-staging
```

The completed import used `--write` with explicit private SDK/config/profile paths.
It verified the AWS operator, each target policy/key and initial version before
writing. Its mode-0600 private receipt keeps a payload fingerprint and one UUID
per record for idempotent retries. Successful writes can precede metadata
propagation; retry with the same receipt, never a fresh token. Changed private
inputs or an unexpected cloud version require reviewed rotation. The importer
never retrieves cloud secret values.

All three imported records subsequently passed read-only TLS 1.3 connections after
resolution through `asm-exec`. To repeat a check without exposing values:

```sh
AWS_PROFILE='Dardan (Lash Her)' AWS_REGION=us-east-1 \
RELEASE_DB_URL='{{resolve:secretsmanager:lash-her/staging/community/runtime:SecretString:STAGING_DATABASE_URL}}' \
asm-exec -- node ops/staging/verify-release-database.mjs CommunityRuntime
```

For `CommunityMigration`, use its `/community/migration` record with the same JSON
field. For `FrontendMigration`, use `/frontend/migration` and `SecretString:DATABASE_URL`.
The verifier pins the exact endpoint/user, starts a read-only transaction and
checks the client TLS certificate. No migration or deployed application flow is
implied by a connection check. Do not print resolved environment variables or
invoke secret-value read APIs directly.

The private source files and import receipt remain mode 0600 under
`/private/tmp/lash-her-p1-02-staging`; this is temporary operator working material,
not the durable release store. Do not move it into Git, tickets or CI artifacts.
Retain it privately for any necessary import recovery, then remove it under the
operator's local retention policy after the handoff is accepted.

## Database role and operational limits

`community-runtime-role.sql` records the applied grant scope; do not rerun setup
blindly. Runtime has public-schema usage, table SELECT/INSERT/UPDATE/DELETE and
sequence USAGE/SELECT, including defaults for future `neondb_owner` migrations.
It has no public-schema CREATE, privileged memberships, superuser, create-role,
create-database, replication or RLS-bypass attribute. The database remains empty;
no cloud application migration ran.

A disposable local PostgreSQL 18 database verified DML/identity-sequence access to
a table created **after** default grants, and denied CREATE/ALTER/DROP/TRUNCATE,
CREATE SCHEMA, CREATE ROLE and SET ROLE owner. The test is
`tests/community-runtime-role.integration.mjs`; it refuses any target except the
explicit loopback test endpoint. The temporary container is removed after testing.

KMS key rotation is enabled, but **Neon credential rotation is not automated**.
Do not attach an AWS-managed RDS rotation workflow to these external Neon roles.
A reviewed manual rotation must update the DB role, publish a new secret version,
verify its consumer and retire the previous credential/version safely. There is
no CI/host consumer yet. Record a rotation owner/cadence and incident procedure
before deployed use.

CloudTrail event history contains the staging `PutSecretValue` events. No persistent
CloudTrail trail was found or created; long-term audit retention, access alerts,
credential-rotation scheduling and release-approval workflow remain operations
work. The store is not evidence of P1-07/P1-08 completion. Existing migration
commands still require reviewed artifacts, target/lineage/lock checks and a
protected one-shot release job before use.
