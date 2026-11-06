# Five exact historical source aliases

Commit `e99975b8ba1aa971dc9f3481f9d73499b43bf753` adds five closed historical source aliases without adding profile files or changing capability policy.

Each alias was independently verified as a commit whose complete Git tree matches its fixed registered base. Full-tree and `src`/`scripts`/`ops` diffs were empty. The executable paths contained no environment read or branch keyed by a Git commit SHA. Alias materialization changes only the top-level and inventory `sourceCommit` plus the derived inventory/profile hashes; all entrypoints, provider annotations, SQL requirements, SDK facts, source-review dispositions, credential-path reuse policy, capability predicates, and external residuals remain those of the exact base profile.

The supported set is now 40 exact revisions backed by the original 33 immutable stored profile files and seven hard-pinned aliases. Seven other unmatched revisions covering eight retained surfaces, plus five surfaces without a source SHA, remain open. They are not accepted by similarity, ancestry, target, or caller-selected bases.

Validation:

- Historical source suite: 25 passed, zero failed or skipped.
- Observer and source-installation suites: 11 passed, zero failed or skipped.
- Owned ESLint and `git diff --check`: passed.
- No provider, credential, production-control, or live deployment call was made.

The aliases do not qualify current candidate admission, global provider absence, credential retirement, or production activation.
