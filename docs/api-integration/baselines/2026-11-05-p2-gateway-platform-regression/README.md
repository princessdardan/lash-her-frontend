# Owned gateway, platform and host regression

The final gateway/platform suite passed 333 tests with 5 explicit skips out of 338 at frontend `9caf16b1a4676cd1e352d57985828d6e9b727c4f`. The host Python suite passed 377 tests with 1 explicit skip out of 378 at `8a64aafcbbcddd63ec36fa44445454a8d4c10173`, whose tree matched root `1f0ad835d1f36da40b671145a6d95fe3aa661f8b`. Every tracked host file remained byte-identical through the final Node revision. No staging or production changes occurred.

Node was `24.18.0`; Python was `3.14.3` on macOS ARM64. The final Node run used the gateway's exact locked `jose@6.2.3`, restored offline into the isolated worktree. The first sandbox diagnostic run had resolved the application's `jose@6.2.15`; its failure log remains diagnostic evidence rather than the dependency-qualified result.

Commands:

```sh
node --test ops/gateway/*.test.mjs ops/platform/*.test.mjs
python3 -m unittest discover -v -s ops/platform/host -p '*_test.py'
```

The initial sandbox denied localhost socket binds: 14 gateway cases failed with `listen EPERM`, and 174 Python cases errored with `PermissionError`. The same suites were rerun with permission for their disposable localhost HTTP/TLS fixtures. Those permission failures cleared. The elevated Node run then retained one actual failure: the old source-CLI fixture still used synthetic identical revisions and expected proof version 3 after publication began requiring a committed P2 review and proof version 4.

Failure logs retain their original bytes, including six whitespace-only assertion-formatting lines across the two Node failure logs.

The authorized correction, `9caf16b1`, changed only four test/fixture files. It creates owned Git repositories with distinct frontend/API commits, a committed released baseline and P2 review, and runs the copied real source CLI while mocking only GitHub transport. It preserves no-overwrite and credential-sanitization checks and denies wrong API pins and missing/tampered reviews. All 45 focused checks passed before the full 338-case rerun. The first fixture attempt also exposed macOS `/var` versus `/private/var` entrypoint aliasing; canonicalizing the test directory fixed it. That failed attempt is retained. Production source and compatibility guards were unchanged.

Recorded skips:

- Four compiled Course worker parser/process cases and one current Course process-parser case require an explicit `COURSE_WORKER_RUNTIME_DIR`. No reviewed built runtime was selected for this frontend run. These skips do not qualify compiled workers.
- The Python `DatabaseRetirementTests.test_fixed_sql_runs_against_migrated_schema_and_actual_terminal_receipt_joins` case requires `FRONTEND_CRM_SHIPPING_POSTGRES_TEST=true` and its owned PostgreSQL fixture. The normal full host unit command leaves that opt-in disabled.

`validation.json` binds the logs, tested revisions, unchanged host inventory, guard hashes, counts and skip conditions. The evidence covers source tests, owned HTTP/TLS fixtures and mocked host/provider operations. Docker image builds, Linux host behavior, PostgreSQL 18 and remote CI qualification remain separate checks.
