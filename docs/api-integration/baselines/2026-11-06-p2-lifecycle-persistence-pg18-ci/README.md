# Phase 2 lifecycle persistence PostgreSQL 18 CI source evidence

This package records the reviewed-source preparation for the owned PostgreSQL
18 lifecycle persistence fixture. It is not PostgreSQL 18 execution evidence,
staging evidence, or a live-provider claim.

## Source boundary

- Baseline: `72bd8af0bc1c9f4438a82721170bca5fbd8ec136`
- CI integration: `ac0ef48f`
- Docker stdin correction: `3c452acf`
- Course source: `a447bfde20299e12afab68a3331b3792ddd07598`
- Community source: `939de65dd52f0b1a43993a25c7c428dce6e2bb43`
- Image: the existing local-only
  `lash-her-frontend-migration:postgres18-test` image built by the owning CI job

The workflow invokes the fixed command:

```sh
node ops/platform/prepare-p2-identity-probe-fixtures.mjs \
  --recovery-postgres18 --lifecycle-postgres18
```

The helper fetches the two fixed private API revisions with the runtime-only
source token, runs the existing 19 identity checks, qualifies the current 55
and forward 19 recovery receipts, and then issues the lifecycle source manifest
internally. The manifest binds the canonical source revisions and trees,
package and lockfile bytes, API artifacts, exact production file maps, the
candidate manifest, and hashes of both preceding recovery receipts.

The persistence child receives only the manifest on stdin. It has no network,
Docker socket, Git metadata, source token, provider credentials, or writable
source mounts. Only this child uses Docker's fixed `-i` stdin forwarding;
the existing current and forward recovery commands remain unchanged. It must
return the exact 13-check PostgreSQL 18 receipt with
matching source-manifest, source-commit, and executable-source hashes.

If a current, forward, or persistence Docker child fails, its bounded stdout,
stderr, and fixed exit metadata are retained outside the disposable checkout at
`$RUNNER_TEMP/p2-owned-fixture-failure/<qualification>/`. Directories are mode
`0700`, files are mode `0600`, and filenames bind the exact frontend commit.
The private-repository CI artifact is retained for three days. Child output is
not copied to the public job receipt, console summary, PR comment, or this
evidence package.

## Local source verification

- 34 focused Node tests passed with zero skips.
- ESLint passed for the changed helper and tests.
- Workflow YAML parsed successfully.
- Production source-map construction read 189 frontend, 262 Course, and 203
  Community files from the currently qualified local source checkouts.
- Missing, extra, content-drifted, and aliased sources refuse.
- Wrong-major, skipped, partial, extra-field, source-pin, manifest-hash, and
  executable-hash receipts refuse.
- Docker transport, child exit, and receipt failures emit only fixed phase,
  stage, and qualification metadata.

## Open qualification

The actual CI job must still run the fixed child against PostgreSQL 18 and
produce the accepted receipt. This package does not project PostgreSQL 16
evidence into PostgreSQL 18 and does not qualify staging.
