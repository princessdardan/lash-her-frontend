# G0 — Dependency remediation and publication readiness

**Observed:** 2026-10-01, America/Toronto  
**Result:** Local dependency audit gates pass in all three repositories. G0 remains **BLOCKED** on publication and fresh CI evidence.  
**Evidence:** [audit, dependency hashes, checks, and remote revisions](2026-10-01-g0-remediation-evidence.json).

## Scope and revisions

This follow-up preserves the [P0-04 baseline](2026-10-01-p0-04.md). The current local bases are frontend `cb5372c83a536840d3ffdc5442771af892305231` (including the P0-04 report), Course `069f88323e3f40bc6a4137feab2baf97c1d3da62`, and Community `97361f173f6a42de238f374317b8f49f79e48876`. Remediation changes are uncommitted working-tree changes; the evidence records package/lockfile hashes. No branch publication, merge, deployment, or shared database migration occurred.

Changes are limited to dependency manifests/lockfiles, API audit CI steps, and documentation. Application source, contracts, and migration history are unchanged. All installs and verification used Node 24.18.0 and npm 11.17.0. Lockfiles were generated through npm without forced upgrades, hand editing, advisory suppressions, or allowlists.

## Audit remediation

| Repository | Before                                     | After                            | `npm run audit:ci` |
| ---------- | ------------------------------------------ | -------------------------------- | ------------------ |
| Frontend   | 29: 4 low, 9 moderate, 15 high, 1 critical | 1 low; no moderate/high/critical | PASS               |
| Course     | 9: 6 moderate, 3 high                      | 0                                | PASS               |
| Community  | 9: 6 moderate, 3 high                      | 0                                | PASS               |

The audit covers production and development dependencies. Frontend retains its existing `--audit-level=moderate` threshold. Both APIs now use the same command in CI, replacing production-only high-severity checks.

Frontend pins Next and eslint-config-next to 16.3.8 and updates the existing patched transitive overrides for Sharp, adm-zip, DOMPurify, js-yaml, markdown-it, brace-expansion, and Undici. Compatible lockfile updates patch gRPC, Browserslist, baseline-browser-mapping, and qs. React 18 / Sanity 4 / next-sanity 11 are retained.

Both APIs update Fastify to 5.12.5 and Vitest to 4.1.11, resolve patched fast-uri and brace-expansion releases, and override only Drizzle's legacy `@esbuild-kit/core-utils` esbuild dependency to 0.25.12. Course also updates tsx to 4.23.15 to remove its esbuild advisory. Community uses drizzle-kit 0.31.11 and explicitly declares dev-only esbuild 0.28.2 to satisfy Vite's optional peer; otherwise npm retained an invalid binding to Drizzle's 0.25.12. Final `npm ls esbuild --all` checks pass in both APIs. Rebuilding the affected Community dependency subtrees through npm removed stale lockfile entries.

### Remaining low finding

[Quill GHSA-v3m3-f69x-jf25](https://github.com/advisories/GHSA-v3m3-f69x-jf25) reports HTML-export XSS in 2.0.3 and lists no patched version. npm suggests a downgrade to 2.0.2; this was not treated as a verified fix. The campaign composer reads `root.innerHTML`; server actions sanitize before saving, and email rendering sanitizes again before sending. Existing sanitization tests pass. These controls do not certify Quill itself or every editor interaction.

The finding remains visible and is below the pre-existing moderate gate. FE owns monitoring an upstream fix or a separately tested editor replacement. This is not an audit exception or a claim of zero vulnerabilities.

## Executed verification

All three repositories passed `npm ci` from their final lockfiles. Database checks used a new disposable PostgreSQL 16.13 cluster listening only on `127.0.0.1:55466`, with separate `lash_frontend_g0_test`, `lash_course_g0_test`, and `lash_community_g0_test` databases. No configured remote database was used.

| Repository | Check                                                  | Result                                                                                                                  |
| ---------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Frontend   | TypeScript, ESLint, Drizzle journal                    | PASS; 11 existing lint warnings                                                                                         |
| Frontend   | `npm run test:unit`                                    | PASS: 1,836 regular + 132 server-only + 19 script tests                                                                 |
| Frontend   | Clean migrations; `npm run test:unit:db`               | PASS: 163/163                                                                                                           |
| Frontend   | `npm run build` with staging Sanity dataset            | PASS, Next 16.3.8; includes Studio                                                                                      |
| Frontend   | Chromium production-server smoke on port 3100          | Home and training render, unknown policy shows 404 UI, no uncaught page errors; Studio renders host-registration screen |
| Course     | `npm run verify`; production compilation               | PASS: type/lint, 365 tests, contract, journal, schema drift, OpenAPI                                                    |
| Course     | Clean migrations; database tests; migration round trip | PASS: 17 tests and 17 migrations                                                                                        |
| Community  | `npm run verify`; production compilation               | PASS: type/lint, 143 tests, contract, journal, schema drift, OpenAPI                                                    |
| Community  | Clean migrations; database tests; migration round trip | PASS: 21 tests and nine migrations                                                                                      |
| Both APIs  | Committed local contract release checks                | PASS: 14 released files and 11 fixtures; `COMMUNITY_RELEASE_REF=HEAD` used only for the local comparison                |
| Community  | Default published-history release check                | EXPECTED FAIL: pinned Community commit is not reachable from `origin/main`                                              |

Fastify reports a deprecation warning for the existing `disableRequestLogging` option; it remains supported in Fastify 5. No source migration to Fastify 6 was made. The PostgreSQL 17 compatibility result remains P0-04 evidence, not a rerun of this patch.

Browser smoke was read-only and used the compiled application. Studio initially showed a loading spinner, then rendered its unregistered-host screen without an uncaught page error. Authenticated editing/publishing, full Playwright coverage, container builds, Prometheus rules, live-provider flows, and deployed cross-service E2E were not verified here. They are not implied by the local checks.

## Publication and CI evidence still required

Read-only GitHub inspection confirms these remote `main` revisions and historical runs:

| Repository | Remote `main`                              | Latest CI                                                                                                 | Failed checks / limit                                                                                                     |
| ---------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Frontend   | `4084a4b83259967661ef2013f1e8c49407df770c` | [36594223315](https://github.com/princessdardan/lash-her-frontend/actions/runs/36594223315), failure      | Audit and database tests; build/quality passed, browser skipped                                                           |
| Course     | `a0c10bd9ba2d36d5fc7c3060e252bb52ce049ba8` | [31905503232](https://github.com/princessdardan/lash-her-course-api/actions/runs/31905503232), failure    | Historical publisher-lock assertion and missing `DEV_DATABASE_URL` during verify; corresponding current local suites pass |
| Community  | `91e91738c0012299643c35a23450aec4818da8d0` | [31905524208](https://github.com/princessdardan/lash-her-community-api/actions/runs/31905524208), success | Older revision; does not certify P0-04 or this remediation                                                                |

All three remote `main` branches report `protected: false`; frontend `staging` also reports unprotected. Protected CI/release implementation remains D-05 / P1-05; this inspection does not establish those controls or approve production migration.

Required next sequence:

1. Review and commit these dependency/CI changes with their evidence in each repository.
2. Publish Community through review/CI while preserving P0-04 commit `97361f173f6a42de238f374317b8f49f79e48876` in the released history. A squash or rebase that drops that SHA requires an explicit Course contract-pin update and revalidation.
3. Publish Course after the pinned Community revision is reachable from Community `origin/main`. Run the default release gate with no local reference override, including the cross-repository checkout/access checks.
4. Publish the frontend baseline and remediation, collect fresh full CI results for the exact selected revisions, including database, audit, production build and browser checks. API CI must also demonstrate containers and Prometheus checks.
5. Record approved starting SHAs and the successful remote run URLs, then review G0. Keep D-06 and G0 open until those records exist. External prerequisites and protected staging/production migration gates retain their owners and dependencies.
