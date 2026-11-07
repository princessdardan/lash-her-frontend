# Owned read-only identity probe evidence

Initial implementation: `fcc51389b8a9b3e3ca9afbb97944d82d89c85248`; independent current-stage lease: `8f27eb1d`; complete operator inventory guard: `057ca736`. All are isolated from frontend base `39c87f1bdde88ad687ccd3a1dcbd201689b78f97`. No existing application, API, driver, workflow, Docker or native-runtime file changed. The fresh scope runs after the initial release scope has closed and opens no SQL session.

The exact source-owned Node program plus fixed launcher has SHA-256 `2d6d83a2053c84bb9dd6c922f424fb570735a8afc1309f688044796c6c9fb3d5` (22,040 bytes). The public operator interface and closed input schema are in [the tool documentation](../../p2-identity-negative-probes.md).

## Executed checks

| Retained output | Actual result and scope |
| --- | --- |
| `owned-node-final.log` | Node 24.18.0: 19 passed, zero failed or skipped. Actual selected Course/Community verifier modules; actual Course app/auth/student/quiz read routes behind owned verified HTTPS; current-only and overlapping-key configurations; independent Python receipt validation. |
| `owned-host-final.log` | Python: 26 passed. Actual release-plan/current-stage entry parsing; private-file, source/candidate/image/configuration, container/mount and receipt guards; real independent-process POSIX flock exclusion/release, inode/permissions/symlink refusal, private stdin, timeout/revocation process-group cleanup. Additional merged-dependency inventory and execution-budget guards pass. Linux/root and Docker execution have explicit test seams. |
| `focused-eslint.log` | Focused ESLint exited zero; empty output. |
| `default-optional-skips.log` | With no explicit compiled API directories: 7 passed and 12 explicitly skipped. The skip reason is retained; this default run supplies no actual-module or deployed qualification. |
| `owned-verifiers.json`, `owned-verifiers-current-only.json` | Sanitized receipts from separately executed actual API modules. The overlap fixture ran 70 named checks per API. Module byte hashes and the selected compiled-source comparisons are retained; `liveImage` is false. |

Selected API source heads were Course `3c0a0d6eee64344d97f98387755e9f34195a4c42` and Community `1ce696a7ae6073cb125da19146789693398b6cc4`, matching the frontend P2 contract pins. The fixture compares selected compiled modules to in-memory compilation using each API's own TypeScript settings. It does not modify or rebuild either API checkout.

The owned HTTPS tests use synthetic keys and immutable in-memory enrollment/course/attempt records. All methods are GET and fixture state remains unchanged. Required refusals include all-401/all-404 baselines, redirects, oversized bodies, an untrusted CA, a missing completed attempt and a leaked other-account attempt. No token, cookie, private answer, runtime configuration value or response body is retained here.

## Failed attempts retained

`failed-compiler-settings.log` records the initial 6-pass/10-fail run. The fixture initially omitted the Community compiler's source-map option, so exact compiled-byte comparison refused. The fixture now consumes each API's actual compiler settings; the byte guard was preserved.

`failed-sandbox-bind.log` records the next 7-pass/9-fail run: the sandbox denied owned loopback HTTPS `listen` with `EPERM`. The explicitly approved owned-socket run passed. No TLS requirement, path allowlist, token predicate or API boundary was weakened. These failures remain distinct from successful negative cases.

`failed-source-inventory-edit.log` and `failed-source-inventory-node.log` retain an uncommitted inventory refactor's unmatched-parenthesis error. Python import refused; Node's independent host-protocol check also refused. The edit was corrected before commit, compilation and all 26/19 final checks. This was an implementation error, not an expected negative or qualified run.

Text logs normalize trailing horizontal whitespace. Where normalization changed bytes, the exact original output is retained in the matching `.log.raw.gz`; `validation.json` records both original and retained byte hashes. Failure content and skip reasons are preserved.

## Remaining deployed prerequisites

No live AWS/provider/host/API calls, actual API SQL, Docker image execution or complete typed Linux broker continuation ran. These logs prove owned source behavior, not P2-12/G2 acceptance.

The implemented fixed entry is `host/p2_identity_probe_current.py`, through the existing pinned SSH and exact committed `OperatorSource` installation. `operation: "plan"` has no runtime capability; `operation: "execute-current-readonly"` calls the independent current-stage scope. That source path still needs actual selected Linux/Docker execution and transport qualification. The owned tests prove actual local POSIX/process behavior and the plan entry, not a simulated Docker pass.

The narrow scope needs the shared host lock and exact source/configuration/candidate/current-container guards. It requires no initial release process, frontend migration session or new SQL claim. It binds the original release and frontend record bytes to their reviewed SHA-256 values, retaining `frontendSqlVerified: false`. The initial process must not be resurrected, migrations reapplied, pending tags edited, services restarted or admission mutated. Physical frontend/deployment verification remains separate certification evidence.

`owned-operator-source-closure.json` binds this actual source inventory, including lazy/shared dependencies, rather than a fixed ten-file assumption. The final merged/published operator source must regenerate and verify its own exact inventory. This baseline inventory must not authenticate later changed `release.py`/`migrate.py`/supervisor imports. The fixed 600-second run budget is operational, not an expiry on Dardan's release approval.

Dardan's reviewed staging release and real enrollment/assessment cases must supply the existing dedicated active subjects, published/enrolled resources and actual completed attempt. The exact running images must then pass the fixed source-owned probe under that fresh scope and retain both successful and failed receipts. Protected frontend workload/OIDC, deliberate previous-key removal and measured authorization/playback expiry remain separate evidence. `oidcVerified`, `keyRemovalVerified` and `releaseAccepted` remain false.

`validation.json` records the precise scopes, counts, source/program identities and output hashes. It is an owned-test record, not a mutable deployment certificate.
