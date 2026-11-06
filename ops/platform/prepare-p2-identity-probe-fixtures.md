# P2 identity probe fixture preparation

`prepare-p2-identity-probe-fixtures.mjs` is a fixed CI preparation command for the existing identity negative-probe tests. It accepts no arguments, URLs, revisions, commands, database configuration or provider configuration. Its only private input is the existing read-only `PLATFORM_SOURCE_READ_TOKEN` environment value used for the two private sibling repositories.

The command reads the released `contracts/api-integration/p2-candidate/manifest.json`, requires the canonical Course and Community repositories and artifact paths, and uses their exact nonzero revisions. It creates a new mode-0700 directory under the system temporary directory outside Git, initializes two empty repositories, and fetches only those exact private revisions. The token is encoded in an ephemeral Git HTTPS extra header available only to each fixed `git fetch` child. It is never placed in a remote URL, command argument, Git configuration file, output receipt, npm environment, build environment or test environment. Each checkout must have the canonical credential-free origin, exact detached `HEAD`, a nonzero Git tree, no tracked changes, and no nonignored untracked files. Ignored source and configuration are also refused; only Python bytecode caches and dependencies beneath the two tracked frontend tool lockfiles (`ops/gateway` and `tools/api-contract-toolchain`) are tolerated. The manifest-pinned OpenAPI and enrollment-event bytes are checked before build.

Execution requires Node 24 and npm 11. Each API must retain package-lock version 3 and the fixed `build:production` script `tsc -p tsconfig.build.json`. Installation is `npm ci --ignore-scripts --include=dev --no-audit --no-fund`; build is `npm run build:production`. Commands receive a replacement minimal environment containing no ambient database, AWS, provider, release, signing or application credentials. The disposable directory, npm cache, dependencies and build outputs are removed on success or failure.

After both clean builds, the command invokes the existing test directly:

```sh
node ops/platform/prepare-p2-identity-probe-fixtures.mjs
```

The child receives only the two disposable runtime directory paths. Its TAP receipt must report exactly 19 tests, 19 passes, and zero failures, cancellations, skips or todos. The existing fixture independently checks the selected API Git heads against the same manifest, compares the required compiled modules with source compilation under each API's actual TypeScript settings, and exercises the actual verifier and owned HTTPS route cases.

Success output contains only frontend/API source identities, Git tree and package/artifact hashes, test counts, and negative scope flags. It contains no checkout path, command output, token, key, URL with credentials, database value or provider response. Failure output is fixed and redacted.

This is exact private-source checkout and owned-fixture preparation only. It performs no SQL, staging request, provider call, image publication, deployment, admission change, service restart, key rotation, release acceptance or Git push. Root workflow wiring and final CI execution are separate. Actual Linux/Docker/staging qualification remains open.
