# Isolated P4-07 Lightsail Frontend bootstrap

This command applies the complete approved frontend chain once to the empty
P4-07 database, then starts a separate PostgreSQL session to verify the current
schema read-only. Its receipts leave traffic unauthorized. The shared staging
and production migration entrypoints retain their existing rules.

Use the dedicated P4-07 host and the approved migration image published by
digest. Before applying, verify the shared admission gates and release holds,
the isolated relay and Square detachment, the PostgreSQL backup, and the exact
candidate and artifact provenance. Pull the verified image before invoking the
operator. The launcher runs with `--pull never`.

## Inputs

Place the reviewed inputs in owner-only directories outside Git. Use two
bundles from `prepare-migrations.mjs --prepare-profiled-current` for the same
P4-07 staging release ID, beginning `p4-07-`. Qualify the bootstrap operator
image and the Vercel candidate migration image independently. Use the exact
source and digest for each image. Both bundles must bind identical SQL,
schema, target, recovery reference and contract. The bootstrap job allows an
empty bootstrap and lists the complete ordered chain. The verification job
disallows empty bootstrap and has an empty pending-tag list.

The job recovery reference is
`p4-07/lightsail/empty-schema/<SHA-256 of the reviewed schema-only backup>`.
The private review JSON contains exactly `bootstrap`, `verification`,
`backupSha256`, and `databaseIdentity`. The `bootstrap` and `verification` objects
each contain the respective `sourceCommit` and `migrationImageDigest`. The
identity contains `version: 1` and the
protected `databaseOid`, `migrationRoleOid`, `runtimeRoleOid`, and
`systemIdentifier` strings verified during target preparation. Both the host
and the migration session independently attest the supplied identity. Supply
the isolated migration URL through runtime secret resolution and pipe it to
the launcher over stdin without trailing whitespace. The operator uses the
fixed database, role, interface address and pinned HBA.

On the isolated host, run the reviewed operator checkout's command as root.

```sh
python3 ops/platform/host/p407_frontend_bootstrap.py \
  BOOTSTRAP_BUNDLE CURRENT_ONLY_BUNDLE PRIVATE_REVIEW SCHEMA_BACKUP RESULTS \
  --confirm staging/P4_07_RELEASE_ID/p4-07
```

This launcher holds the host release and database configuration locks across
both runs. Each exact image command obtains the existing PostgreSQL advisory
lock and uses hostname-verified TLS. The exact Vercel candidate image runs its
existing profiled current-only command in the second step. Before any migration it checks that the
journal and application schema are empty, only the operator is connected, and
the relay is detached. The pinned Docker network and the selected PostgreSQL
server and client addresses are mandatory. Checkout and normal release
commands cannot select this bootstrap scope.

The `bootstrap/` and `verify-current/` result directories contain exclusive
`database-receipt.json` and `job-outcome.json` pairs. Only the verified
`verify-current/` pair can serve as the current-only database input to the held
Vercel launcher. Both receipts must match the exact deployed source digest and
target, with zero applied migrations, read-only verification true, and traffic
authorization false. Success also retains `isolated-bootstrap-outcome.json`.

If a step fails, leave the relay detached. Inspect both receipts and the real
journal before a deliberate recovery decision. The launcher's bootstrap mode
refuses a non-empty target, including after a partially committed attempt.
