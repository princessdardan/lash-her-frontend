# Exact-tree historical source aliases

This bounded change supports two retained preview source revisions without adding duplicate profile files:

- `e82645b6c045ce88dbaacf3c32cff8606a8592a8` has the exact tree `eca5b5ead0d026822a68788f9332ae550f6fbfe0`, already stored for `45223fec3ee71bf63cfb0e44a94a0a7b3e282ca1`.
- `85dea97b0deae17cff19e345268bddafeba9fe28` has the exact tree `aa9ccfc57e3e4e6a385dad83aacde571a822bb52`, already stored for `13142937adf542e41d0a12807d2503389933f74e`.

Each alias is a closed mapping in `frontend-historical-source.mjs`. It pins the source revision, stored profile revision, identical tree, and full materialized profile hash. Materialization changes only the top-level and inventory `sourceCommit` fields, then derives the inventory hash. Existing Git tree, blob, excerpt, inventory, and whole-profile verification still runs against the alias source revision.

The aliases do not reuse admission, configuration, effects, or deployment-status conclusions. The retained `ERROR` deployment state is not absence evidence. Each surface still requires its authenticated original catalog and configuration provenance, and the matching profiles preserve their conservative unknown/reachable provider treatment and external residuals.

Verification used Node 24.18.0:

```text
node --test ops/platform/frontend-historical-source.test.mjs \
  ops/platform/frontend-historical-source-observer.test.mjs \
  ops/platform/recreation_source.test.mjs

36 passed, 0 failed, 0 skipped
```

Targeted ESLint and `git diff --check` also passed. This is owned implementation evidence; independent review remains pending.
