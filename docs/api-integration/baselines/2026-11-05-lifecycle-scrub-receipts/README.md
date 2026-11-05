# Lifecycle export scrub receipts

The source review at `6470058b6fb03e3e616341a3c100db199de6f8df` found that `failExport` and `expireExports` checked `UPDATE RETURNING` without reading the persisted private bytes. An owned PostgreSQL 16 fixture with all 83 migrations reproduced an `AFTER UPDATE` fault restoring only the old `data`/`frontend_data` after the returned tuple. Failure returned successfully, expiry reported one cleared row, and enclosing admission completed cleanly while both private snapshots remained. Later cleanup returned zero because terminal rows were excluded. The original [reproduction result](pre-fix-reproduction.log) is retained; this injected physical-receipt fault does not assert that such a trigger exists in a deployed database.

The correction reads the locked row after every scrub and requires the exact intended persisted receipt. A mismatch throws, rolls back the terminal transition and retains admission uncertainty. Successful ready exports remain authoritative. Existing failed/expired rows containing private bytes are eligible only for the byte removal already required by those outcomes. Bounded recovery locks at most 100 rows, preserves failed/expired statuses and existing expiry/readiness/ownership metadata, and keeps command history, delivery receipts, account versions, financial and marketing records unchanged. A successful repair is followed by zero additional cleanup. No new retention period, command or expiry extension is introduced.

Run the source-bound owned database regressions from the repository root with Node 24 and PostgreSQL 16:

```sh
LIFECYCLE_SCRUB_OWNED_TEST=true \
  NODE_BIN=/Users/dardan/.nvm/versions/node/v24.18.0/bin/node \
  PG_BIN=/opt/homebrew/opt/postgresql@16/bin \
  python3 docs/api-integration/baselines/2026-11-05-lifecycle-scrub-receipts/run-owned.py
```

The launcher creates and removes a loopback TLS/SCRAM cluster, applies the 83 repository migrations and runs the lifecycle store/fault suites against a separately named owned database. It accepts no database URL and passes only synthetic fixture credentials privately to the child. Both libpq and Node verify the fixture CA and host identity. Physical fault tests restore bytes after `RETURNING`, require rollback and sticky uncertainty, then verify actual successful removal after the fault stops. Additional cases repair existing terminal bytes, protect a concurrently ready export and preserve immutable references.

The [validation record](validation.json) binds source, original reproduction, owned database results, focused non-DB regressions, TypeScript and lint. These source checks do not certify live provider delivery, deployed scheduling, historical producer fencing or G2. No live account, database, provider, secret retrieval, scheduler, deployment or admission change accompanies this fix.
