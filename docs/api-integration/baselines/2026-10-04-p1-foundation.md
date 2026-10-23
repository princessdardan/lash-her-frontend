# P1 foundation — contract candidate and environment preparation

Observed 2026-10-04, America/Toronto. P1-01 is **VERIFYING**; P1-02 is **BLOCKED**.
Dardan instructed this chat to continue to P1 after completing the P0 steps.
P0-01–P0-04 remain done. Fresh read-only GitHub inspection confirmed the baseline
merges, frontend browser pass, post-merge compatibility and Course release gate;
[G0 closure](2026-10-04-g0-closure.md) records the approved baseline revisions.
This P1 work is local preparation, with no deployment or release approval.

## Implementation

- [v1 candidate bundle](../../../contracts/api-integration/v1/README.md): exact
  committed Course/Community OpenAPI snapshots, enrollment-event schema, SHA-256
  pins, and proposed learner/member/admin/lifecycle wire schemas.
- Generated OpenAPI types for both APIs and candidate boundary types, with
  deterministic generation and integrity/drift checks in frontend CI.
- Server-only response parsing validates documented operation/status schemas,
  preserving current Course/Community error envelopes and rejecting malformed
  payloads without mutation, coercion or disclosure of upstream data.
- Boundary schema/lifetime parsing covers canonical customer/admin subjects,
  audience/capability separation, short bounded JWT claims, and lifecycle payloads.
  Signature verification and runtime receivers remain Phase 2; these parsers do
  not establish authentication by themselves.
- Conservative candidate-versus-released compatibility checks preserve existing
  operations, security and components. Candidate release checks fail closed and
  released checks require an explicit released baseline.
- [P1-02 worksheet](../p1-environments.md) maps both environments' processes,
  credential/provider isolation, resource verification and cost inputs. Render
  workspace/services and Vercel staging selection were requested in this chat.

Application behavior is unchanged: these modules are not connected to existing
pages, sessions, checkout or API handlers. There were no API runtime/migration
changes, provider changes, paid provisioning, shared DB migrations or deployments.
Pre-existing tracker/publication-document edits were preserved.

## Revisions

| Repository | Source revision                                                             |
| ---------- | --------------------------------------------------------------------------- |
| Frontend   | Base `1d8342ab93b6713bebbb3a9caabaa54a246f9957`; this change is uncommitted |
| Course     | `a809b1e61051d8908892830bbeb80762448c879d`                                  |
| Community  | `ac88eb9840c8ec1ad85cc414d31c6f70831d1e3f`                                  |

The [manifest](../../../contracts/api-integration/v1/manifest.json) records exact
source paths and byte hashes. Community's event-schema bytes retain the earlier
P0-04 contract's hash. New frontend contracts must be reviewed, committed and
published before they can serve as release inputs.

## Executed checks

All commands used Node.js **24.18.0** and npm **11.17.0**.

| Command                             | Actual result                                                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run contracts:generate`        | PASS — generated both APIs and candidate boundary types                                                                                                                          |
| `npm run contracts:check`           | PASS — pinned hash integrity and deterministic generated output                                                                                                                  |
| `npm run contracts:sources`         | PASS — all vendored source bytes match the exact sibling commits                                                                                                                 |
| Focused boundary/response tests     | PASS — seven tests; every documented JSON response schema compiled                                                                                                               |
| `npm run contracts:test`            | PASS — four tests for immutable pins, corruption/release refusal, mandatory source/baseline verification and compatibility                                                       |
| `npx tsc --noEmit`                  | PASS                                                                                                                                                                             |
| `npm run lint`                      | PASS — zero errors, 11 existing warnings; changed-file lint also passes                                                                                                          |
| `npm run test:unit`                 | PASS — full suite: 1,831 regular source + 135 server-only + 22 script tests; final script rerun passes 23 tests after adding the release-guard case (1,989 distinct final tests) |
| `npm ci --ignore-scripts --dry-run` | PASS — package/lock consistency; not a clean-install execution                                                                                                                   |
| `npm audit --json`                  | FAIL at the existing moderate gate — 13 high plus one low finding                                                                                                                |

The first sandboxed full unit attempt failed when tsx subprocesses could not
create local IPC sockets (`EPERM`). The same suite passed with approved sandbox
escalation. No test or database guard was weakened.

The high audit findings originate from the braces stack-exhaustion advisory and
its existing Sanity/Next lint chains. Pre-change and current root package versions
match: braces 3.0.3, micromatch 4.0.8, fast-glob 3.3.1, chokidar 3.6.0. Added Ajv,
ajv-formats and openapi-typescript are not listed as findings. The former P0 audit
pass is dated evidence; it does not certify this fresh advisory state. D-09 records
remediation/review for P1-05. No `audit fix --force` or major framework/CMS downgrade
was applied, and the moderate threshold remains intact.

## Outstanding evidence

P1-01 cannot close as a released/reviewed contract until source owners review the
candidate, its frontend revision is published, an approved released baseline is
recorded. G0 publication evidence is now reconciled. There is no previous released
three-application bundle against which to claim release compatibility. Runtime
authentication and account-lifecycle behavior retain their Phase 2 owners.

P1-02 cannot close without authenticated staging/production resource IDs,
environment/provider isolation, ownership and an actual cost estimate. Costs
remain unknown, not zero. The worksheet is preparatory configuration, not a
deployed staging inventory. P1-03–P1-08/G1 remain unstarted because their required
contract/environment/deployment evidence is not yet available.

No DB integration, browser, deployed network/TLS, provider, container startup,
load, migration, rollback or monitoring incident checks were performed for this
change. Those claims remain at their explicit downstream gates.
