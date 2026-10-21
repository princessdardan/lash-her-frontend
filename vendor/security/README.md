# Maintained dependency security forks

These are local, private forks, installed as ordinary npm dependencies from the
committed tarballs. Nothing is published to npm and no installation scripts patch
`node_modules`. `forks.json` records upstream archive URLs and integrity, advisory
IDs, fork identities, packed file hashes, and archive integrity. `patches/` records
the reviewed changes against those upstream archives. Upstream licenses and
documentation are retained; the YAML loader's missing npm-archive license was
recovered from the upstream repository identified in the manifest.

## Braces

`@lash-her/braces@3.0.3-lash-her.1` derives from `braces@3.0.3` and addresses
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
The parser refuses brace/parenthesis nesting above 128 before constructing deeper
nodes. An iterative preflight protects compile, expand, and stringify, including
direct AST calls and internal stringify paths. It rejects cyclic child graphs.
`parent` and `prev` references are intentionally excluded because the parser uses
those back references. Normal patterns, exports, character limits, and expansion
limits retain their upstream behavior. Options cannot raise or disable the
security nesting ceiling. Rejection is a `SyntaxError` with the stable code
`ERR_BRACES_MAX_DEPTH` (or `ERR_BRACES_CYCLIC_AST` for cycles).

## YAML loader

`@lash-her/load-yaml-file@0.2.0-lash-her.1` derives from `load-yaml-file@0.2.0`.
It replaces `js-yaml@3`/`safeLoad` with `js-yaml@4.3.2`/`load`, preserving the
CommonJS callable async API, `.sync`, BOM stripping, and file errors. This removes
the legacy `argparse@1` and `sprintf-js` dependency chain implicated by
[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
YAML follows js-yaml 4's safe default schema; JavaScript tags are rejected.
Sanity's existing CommonJS package-manager detection remains compatible, including
reading pnpm's `.modules.yaml`.

## Installation and verification

The root manifest directly declares the two archive dependencies under the
original import names. Root overrides reference those declarations with `$braces`
and `$load-yaml-file`, so every transitive caller uses the same installation.
The references also avoid npm resolving a relative tarball separately from each
transitive package's directory.

Run on Node 24:

```sh
npm ci
npm run verify:security-forks
npm run test:security-deps
npm run audit:ci
```

Verification compares every source and archive file, archive integrity, lockfile
identities, and installed bytes at every affected dependency path. It rejects any
remaining legacy `sprintf-js` or `argparse@1` installation. The regression suite
exercises hostile and ordinary inputs plus actual downstream consumers.

npm audit cannot map these private fork identities to their upstream advisories.
A passing audit alone is not evidence that the forks are safe. CI therefore runs
integrity verification and behavioral regressions before the unchanged audit.
The upstream identities and advisories remain explicit in this inventory; no
advisory allowlist, omit flag, or severity-threshold change is used.

## Maintenance

Update source, fork version, and the corresponding patch together, then run
`npm run pack:security-forks`. Commit the rebuilt archive and updated manifest in
the same change. The packer disables package lifecycle scripts. Repacking unchanged
source must retain the archive integrity; verify the result with the commands
above. Formatter/linter exclusions preserve vendored source bytes.

Review removal whenever the dependency tree changes. Replace a fork when a
published upstream fix or compatible parent update removes the vulnerable
implementation and passes the same regression suite. Keep the application on the
selected framework cohort until a separate coordinated migration is validated.
