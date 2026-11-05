# Phase 2 platform harness and protected probe

The current platform harness has an explicit P2 path. `local-harness.mjs --phase p2` uses the candidate catalog validator, the fixed entitlement service subject `frontend`, independent learner/admin current keys and the closed administrator v1 profile. `published-recovery-harness.mjs` selects P2 only when both reviewed candidates have `contractPhase: "p2"`; a P1/P2 application rollback is refused. Historical P1 mode retains its original catalog validator and role profile. Neither path changes published v1 bundle bytes or historical receipts.

The P2 Compose harness includes all ten application services. Its two additional workers receive only their named database URL and explicit false loop flags. Readiness and disabled metrics must pass; they receive no user/service JWT or Mux provider key. Published-image replacement includes those workers in image inspection and graceful stop. The private TLS proxy permits the exact configured PUT quiz and DELETE caption operations while continuing to deny other methods, routes and peers.

The protected application release probe accepts explicit staging-only `x-lash-release-mode: phase2`. It uses the P2 catalog parser and the execution's workload transport, with the same expiring bearer credential, challenge, reviewed project/source and verified TLS requirements. It does not invoke the pre-SQL bootstrap reader or require feature controls to be disabled. It returns `contractPhase: "p2"` and `gateway-course-catalog-p2` with `private, no-store`. Unknown modes, missing configuration and parser failure refuse; there is no parser fallback. Admission-bootstrap, Resend and Square modes retain the legacy pre-SQL path.

The host's final verifier selects that mode only for an atomic P2 release binding and retains the exact P2 manifest hash in its outcome. Historical mode-absent requests and outcomes remain unchanged. The API current-state read-only emitter similarly includes the P2 pair only when both validated fields are present; partial/malformed pairs fail before SQL. Schema catalog hashes and the historical v1 `contractSha256` retain their existing meaning.

## Executed source qualification

Node 24 local checks passed: 12 frontend probe/smoke tests, 16 current-state/fixture tests, three profile/parser cases using the actual compiled Course configuration, 17 gateway/TLS tests and 26 host probe/runtime-action tests. TypeScript and focused ESLint passed. Existing P1 assertions remain in these suites.

`test-phase2-platform-local.mjs` passed eleven checks against Course `dd0ae7179eea51173285e472d28467de1e2793c4` and Community `ae9624489208b57cf408dacfcfb2240dc839a3d6`. It builds those exact clean sources, applies full migrations to two owned loopback PostgreSQL16 databases, runs their actual Fastify processes, and tests signed workload authorization through the actual gateway and verified public/private TLS. The protected P2 probe validates actual catalog metadata. The fixture exercises audited admin grants, legacy/cross-profile/capability denials, the exact service subject and replay, real Community enrollment acknowledgement/replay, and minimal disabled workers with graceful shutdown. It accepts no external database URL and removes its owned cluster and synthetic keys.

One early fixture attempt expected 401 for an authenticated learner at an admin route. The current Course `requireAdmin` correctly returns 403 for that caller; the assertion was aligned with that existing behavior. Two private-TLS test attempts were corrected for an unframed DELETE fixture body and an unavailable macOS loopback alias. No application authorization rule was weakened.

Docker Desktop's local socket was unavailable. No local image, published rollback, deployed Vercel OIDC or provider certification is claimed. The remote platform job must use `--phase p2` with the final combined API sources and immutable images; the independent API CI remains required.

Reproduce the source fixture with the normal locked frontend/API dependencies, Node24, PostgreSQL16 and explicit source pins:

```sh
PHASE2_PLATFORM_LOCAL_TEST=true PG_BIN=/absolute/postgresql16/bin \
PHASE2_COURSE_SOURCE_ROOT=/absolute/course-api \
PHASE2_COMMUNITY_SOURCE_ROOT=/absolute/community-api \
PHASE2_COURSE_SOURCE_COMMIT=<reviewed-40-hex> \
PHASE2_COMMUNITY_SOURCE_COMMIT=<reviewed-40-hex> \
node --import ./scripts/register-server-only-test.mjs --import tsx ops/platform/test-phase2-platform-local.mjs
```
