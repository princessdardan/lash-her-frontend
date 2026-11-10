# Managed Neon replacement ACL action

This source-only action removes the two reviewed default `PUBLIC` privileges from the selected empty Neon replacement database. It does not provision a resource, prepare roles, run application migrations, authorize a release or contact Neon APIs. It has not been run against live Neon.

## Fixed scope

The action accepts only:

- catalog `staging-neon-replacement-2026-11-09` with source-pinned SHA-256 `a2215d75c64cce39711c4e616974a6a5f97d6ea273479f1868db4c746269a715`;
- the baseline's exact Neon project, branch, endpoint, direct non-pooler host, database OID, migration-role OID, administrative logins and `neondb_owner` target;
- one clean 40-character frontend source commit containing this action;
- the exact reviewed predecessor target needed by the existing replacement boundary verifier;
- the single statement `REVOKE CONNECT, TEMPORARY ON DATABASE neondb FROM PUBLIC`.

The input object has exactly these properties:

```json
{
  "version": 1,
  "operation": "apply-managed-neon-replacement-public-acl",
  "environment": "staging",
  "actionId": "p2-neon-replacement-public-acl-2026-11-09",
  "sourceCommit": "<exact-clean-frontend-commit>",
  "managedCatalog": {
    "id": "staging-neon-replacement-2026-11-09",
    "sha256": "a2215d75c64cce39711c4e616974a6a5f97d6ea273479f1868db4c746269a715"
  },
  "provider": {
    "kind": "neon",
    "projectId": "noisy-river-83285109",
    "branchId": "br-holy-art-bc3aif1l",
    "endpointId": "ep-lingering-meadow-bc80gyj9",
    "directHost": "ep-lingering-meadow-bc80gyj9.c-16.us-east-1.aws.neon.tech"
  },
  "target": {
    "host": "ep-lingering-meadow-bc80gyj9.c-16.us-east-1.aws.neon.tech",
    "port": 5432,
    "database": "neondb",
    "user": "neondb_owner",
    "runtimeRole": "lash_her_frontend_staging_runtime_p2",
    "serverMajor": 18
  },
  "predecessorTarget": "<copy the exact predecessor target from the reviewed replacement plan>",
  "databaseOid": "16397",
  "migrationRoleOid": "16393",
  "administrativeLogins": [
    { "name": "cloud_admin", "oid": "10" },
    { "name": "neon_service", "oid": "16395" }
  ]
}
```

The strings in angle brackets describe required copies; they are not valid action input. Keep the completed input in an owner-only location outside Git. Do not add a credential to it.

## Review and apply

Use Node 24 from the exact clean source commit. The plan mode is read-only and resolves no database credential:

```sh
node ops/platform/p2-neon-replacement-acl.mjs --plan < /owner-only/p2-neon-replacement-acl.json
```

Review the emitted target, baseline SHA-256, statement, statement SHA-256 and `ownerConfirmation`. Dardan starts the reviewed action with the exact confirmation. Create a new empty mode-0700 directory outside Git for its receipts.

```sh
node ops/platform/p2-neon-replacement-acl.mjs --apply --confirm 'staging/p2-neon-replacement-public-acl-2026-11-09/<exact-clean-frontend-commit>/a2215d75c64cce39711c4e616974a6a5f97d6ea273479f1868db4c746269a715' \
  --results /owner-only/p2-neon-replacement-acl-results < /owner-only/p2-neon-replacement-acl.json
```

Resolve `FRONTEND_STAGING_MIGRATION_DATABASE_URL` through the existing private runtime handoff. The URL must select the exact direct Neon host, `neondb`, `neondb_owner`, and only `sslmode=verify-full`. Do not print, paste or retain the URL in action input or receipts. If it is backed by AWS Secrets Manager, resolve it at command runtime with the approved `asm-exec` dynamic-reference path; never fetch or print the secret value.

The process holds the frontend environment lock and one physical PostgreSQL migration advisory lock. It pins the same connection object, backend PID and backend start time throughout. On that verified-TLS session it proves the exact pre-ACL managed catalog, both original `PUBLIC` privileges, the absence of `PUBLIC CREATE` on the database and schema, the absence of prepared frontend roles and other client backends, and the exact effective login set. It rechecks those conditions in a serializable read-write transaction, executes the fixed statement, and verifies the resulting roles, memberships, default ACLs, catalog dependencies and database ACL before `COMMIT`. After commit it runs the complete managed replacement boundary verifier again. The post state retains `cloud_admin`, `neon_service` and `neondb_owner` access. `neon_service` inherits its explicit access through the pinned `neon_superuser` membership and ACL.

## Failure disposition

Any failure returns `P2_MANAGED_NEON_REPLACEMENT_ACL_FAILED_REVIEW_REQUIRED` with `automaticRetryAllowed: false`.

The tool durably records the intent before SQL and retains a terminal receipt after verification or failure. An intent without a terminal, a lost commit response, or a failed post-commit check requires reconciliation. Preserve the input, source commit and original receipts. Use the read-only managed replacement arm to determine actual state before preparing a new reviewed action.
