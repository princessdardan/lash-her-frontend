# Proposed owned C PostgreSQL 18 positive run

Not executed. Run only after root freezes a clean exact frontend revision and the required shared test gates pass. This is disposable local qualification, not staging/provider/Docker qualification.

Local source HEADs were read and match the new selectors:

* Course `/Users/dardan/workspace/lash-her-course-api/.worktrees/p2q-course`: `0bb054d5a04db71c481a8b3d182db6df19782cdc`.
* Community `/Users/dardan/workspace/lash-her-community-api/.worktrees/p2q-community`: `8594d953a5c0e0849e7a2e5e0de21f03537c4dc4`.

The previously verified owned PostgreSQL 18 prefix remains executable at `/private/tmp/pg18-forward-owned-u5qd0tla/prefix/bin`. Do not rebuild it or start Docker. Confirm the frontend is at the intended frozen commit, its tree is clean, the two API source/lockfiles remain exact, and installed dependencies remain available. The existing fixture independently archives the exact default commits, compares lockfile bytes and records its actual source.

The output directory must be fresh. This command uses only existing source flags and new API source roots; it does not reuse or modify any old retained C receipt/snapshot:

```sh
set -eu
umask 077
mkdir /private/tmp/p2q-current-api-c-owned-20261106
cd /Users/dardan/workspace/lash-her-frontend/.worktrees/phase2-integration
env -i \
  PATH=/Users/dardan/.nvm/versions/node/v24.18.0/bin:/opt/homebrew/opt/openssl@3/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  LANG=C LC_ALL=C \
  TMPDIR=/private/tmp/p2q-current-api-c-owned-20261106 \
  PG_BIN=/private/tmp/pg18-forward-owned-u5qd0tla/prefix/bin \
  OWNED_POSTGRES_MAJOR=18 \
  P2_INTERRUPTED_OWNED_TEST=true \
  P2_KNOWN_ACK_COURSE_SOURCE_ROOT=/Users/dardan/workspace/lash-her-course-api/.worktrees/p2q-course \
  P2_KNOWN_ACK_COMMUNITY_SOURCE_ROOT=/Users/dardan/workspace/lash-her-community-api/.worktrees/p2q-community \
  /Users/dardan/.nvm/versions/node/v24.18.0/bin/node \
  docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs \
  > /private/tmp/p2q-current-api-c-owned-20261106/positive.stdout \
  2> /private/tmp/p2q-current-api-c-owned-20261106/positive.stderr
```

Do not supply old source-commit overrides or new hooks. Inspect the exit status, private stderr and actual receipt rather than assuming success. The result must identify the frozen frontend and new API revisions, PostgreSQL18, actual 83/22/11 migrations, fresh physical process/backend/host flock, the unchanged causal/terminal joins and journals, and honest projected runtime/provider scope. A failure is retained unchanged; it does not authorize a retry or a predicate change. The original `758c...` and `5fedd...` receipts remain historical.
