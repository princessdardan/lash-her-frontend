# Frontend target-profile component qualification

Source foundation: `5e007c4447cb1070c8718fa16bb0ca73e0b69213`. Domain source: `663c182fb9c79ae788bf694c8886ca6265d38594`, corrected separately by `df81897327086021bdf4dfa12e6a1f53e249f33a`. The fixture-copy dependency is root commit `ccc4f8fc96dc8c4b3cc425d8f765798e1442c610`; the historical/bootstrap pure-helper dependency is `eaeb43b98579373b79ccba732a22d4fc7d8e83e9`. This evidence does not independently clear those dependencies.

`qualification.json` binds the 13 owned executable/test files and retained raw records. `current-profile.canonical.json` is the actual resolved source definition, 371 bytes without a newline, with the frozen `ea8875...` digest. The [interface runbook](../../frontend-target-profile-propagation.md) lists the exact expected-context positions and deliberately unavailable actions.

## Corrected source results

- Node 24.18.0 focused tests: 67 passed, zero skipped, including the 15 historical/bootstrap dependency tests. Focused ESLint passed.
- Owned PG16 and PG18 role fixtures: 29 checks each, no stderr. Genuine profiled creation and reuse authenticate actual generated credentials and observed OIDs. The same-profile, same-target private-record swap fails before verification hooks, SQL or new intents. Existing role/GUC/ACL/default/membership/namespace checks remain.
- Owned PG16 and PG18 migration fixtures: all 83 migrations and 18 named checks each. The actual fixed profiled CLI verifies current state with server read-only enabled and emits v2/profile-bound database and terminal receipts. Pending execution creates no started/database receipt and leaves the actual journal and schema unchanged. Existing identity, lifecycle, route, worker, admission and historical fixture groups remain in the raw records.
- The initial source accepted arbitrary callbacks as sufficient pending-SQL context. The correction refuses profiled pending SQL unconditionally before dependency hooks. Its positive continuation test now exercises the read-only path; no-op and callback-shaped pending calls are negative controls.

## Original bootstrap/restoration scope

The PG16 and PG18 bootstrap/restoration records are explicitly labeled **source 663c**, rather than relabeled as corrected whole-tree runs. Each passed 12 checks, including actual closed admission bootstrap with observed owner/runtime OIDs, ordered profiled restoration, and lost-commit acknowledgement with v2 uncertainty retained. These implementations did not change in the corrective commit. Their boundary server is an owned loopback fixture.

## Original failure and correction control

The same-profile swap regression was first executed against the original role module. Two genuine source-created private records have the same working credential and target, but different original plan hashes. The new fixture's pre-effect tripwires fail against the original module at `profiled-same-target-private-record-swap`. The retained red stderr is closed metadata; stdout was empty. This is a mixed-source control: the corrected test fixture with the original 663c role module, not a claimed whole-commit pass.

The original 663c tests and all 24 private outputs were preserved before correction in `/private/tmp/p2q-frontend-db-profile-source-663c/manifest.json`, whose SHA256 is recorded in the qualification file. The portable original test output and red control are retained here. No original receipt was restamped.

## Commands and limits

Runs use a closed environment with Node 24 on `PATH`, `LANG=C`, `LC_ALL=C`, the fixed owned-test flags, and an absolute local PG16 or PG18 binary directory. Each fixture creates and removes its own loopback cluster. Migration runs use `FRONTEND_MIGRATION_LOCAL_TEST=true`, plus `FRONTEND_MIGRATION_POSTGRES18_LOCAL_TEST=true` on PG18. Role runs use `FRONTEND_ROLES_OWNED_TEST=true` and `OWNED_POSTGRES_MAJOR=16|18`. Restoration runs use `FRONTEND_RESTORATION_LOCAL_TEST=true`.

The first sandbox role invocation failed before cluster/application work. A separate fixed loopback control observed `EPERM`; the authorized owned runs then used the necessary sandbox escalation. No external database or provider URL was supplied. Migration/restoration stderr retains the existing `MODULE_TYPELESS_PACKAGE_JSON` Node warning; it was not suppressed or reported as empty.

Candidate/source/image selectors in these fixtures are synthetic. These checks do not establish image packaging, Linux CI, live provider state, whole-environment first-install authority, complete profiled coordinator execution, candidate publication or release acceptance. Full source integration and exact candidate CI remain required.
