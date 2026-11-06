# Staging deployed identity negative probes

`host/p2_identity_negative_probe.py` prepares a plan by default. Its in-process `execute(bundle, configuration, reviewed_probe, operator_source, lease)` is a source-owned continuation for the existing reviewed staging certification driver. It creates no account, grant, assessment, progress, lifecycle command, key, schedule or provider state. No browser receives signing material. There is no token-minting or proxy endpoint.

The deployed continuation is not wired by this package. Linux/container execution, final operator-source CI/publication, actual test records and deployed results remain certification gates. An owned fixture pass is not P2-12/G2 acceptance.

## Prerequisites and order

Run after the reviewed enrollment and assessment cases have produced the selected records:

- Three distinct existing staging UUIDs: active learners A and B, and the selected administrator.
- Three existing published courses: A is enrolled in course A and lacks course B; B is enrolled in course B and lacks course A. Both are actively enrolled in the shared course.
- A quiz lesson in the shared course and an actual completed attempt owned by learner A. The attempt must be present in A's authenticated history and absent from B's authenticated history.
- Current learner/admin Course keys and member/admin Community keys already configured in the exact selected runtime. Configured previous keys are listed explicitly. An unconfigured positive baseline is a refusal, not a successful all-401 result.

The tool performs only fixed GETs. It never prepares missing records, submits an attempt, grants access or rotates configuration. Missing enrollment, missing completion, 401/404 baselines, unexpected success or an incomplete checklist fail. Existing API quota/account-access checks still apply.

## Public reviewed input

The closed version-1 record contains exactly:

| Field | Binding |
| --- | --- |
| `environment`, `probeId`, `releaseId` | `staging` and the existing reviewed action identity |
| `candidateSha256`, `hostMachineId` | Exact candidate bytes and selected Linux host |
| `sources` | Exact `frontend`, `course`, `community` commits |
| `containers` | Exactly gateway, course-api and community-api; full IDs and immutable GHCR image references |
| `configurationSha256` | SHA-256 of compact sorted ASCII JSON mapping the existing fixed `staging_state.CONFIGURATION_FILES` to their byte SHA-256 values |
| `programSha256` | SHA-256 of the committed `p2-identity-negative-probe.mjs` bytes followed by `\nawait runPrivateProbeFromStdin();\n` |
| `subjects` | Exactly `learnerA`, `learnerB`, `admin` UUIDs |
| `resources` | Exactly `courseA`, `courseB`, `sharedCourse`, `lesson`, `completedAttempt` UUIDs |
| `previousProfiles` | Sorted configured subset of `course-learner`, `course-admin`, `community-member`, `community-admin` |

There is no public key, token, URL, hostname override, path, command, callback or arbitrary header field. These bindings are prepared within the existing authorized certification scope; they add no approval/signing ceremony. Changed candidate, configuration or resources require the corresponding normal reviewed scope update.

The CLI accepts only `--bundle`, `--configuration` and `--reviewed`. It prints the plan and consumes no credentials or network capability. It has no standalone apply flag. The existing supervisor/broker later invokes `execute` under its actual `P2ReleaseScope`; JSON flags cannot construct that capability.

## Guarded execution and private input

The continuation requires the actual process-local scope, its exact candidate, original verified frontend receipt and live physical frontend observer. It acquires no second lock. It reuses `release.make_plan`, the current full runtime inventory and exact candidate/source/job bindings. The fixed public host is `api-staging.lashher.com`; private target is exclusively `https://course-tls:8443`. Production and foreign targets refuse.

Operator source must be installed at `/opt/lash-her/operators/<selected frontend commit>`. Runtime input must be a private nonsymlink path beneath `/var/lib/lash-her/releases/staging`. Program bytes, original configuration digests and selected container identity are checked before and after each operation. All selected containers require read-only roots. API containers cannot overlay `/app` or modules; the gateway's only bind mounts are the exact reviewed read-only gateway configuration, admission directory and TLS directory. The full ten-service runtime inventory is checked at entry and exit.

The parent privately consumes the fixed existing `course-api.env` and `community-api.env` through the existing database-target/TLS/runtime-role parser. It reads no AWS, credential-store or secret-fetch API. AWS-held values must already have entered that reviewed runtime handoff through the existing `asm-exec` dynamic-reference mechanism, outside agent context. No new secret store is introduced.

Only the source-owned child receives the required key subset through stdin. Keys are never command arguments, files produced by this tool, receipts or logs. User/profile keys must be distinct from each other and from configured service credentials. The probe requires 32–8192-byte printable nonwhitespace key material and refuses ambiguous configuration rather than trimming it. Each API child privately compares the original configuration with its actual process and parsed runtime keys before using the actual verifier factory. The gateway child verifies actual mounted configuration and CA byte hashes. No tokens, cookies, claims, certificate bodies, connection strings, question/answer content or upstream error bodies enter common output.

The Node 24 program uses built-in crypto, filesystem and HTTPS, plus fixed imports of the actual API image's verifier/runtime modules. Its source is passed nonsecretly to the exact existing container. It assumes no host Node installation. `P2ReleaseScope.run` must include the stdin-capable interface from driver commit `05c20e5b`; the original scope/observer controls remain authoritative.

Each deployed HTTP child performs **one** allowlisted GET. Lease loss starts no subsequent request; an already-issued bounded read may finish. This does not claim cancellation of an in-flight effect. Children are registered with the existing scope and cannot authorize work or admission. Requests reject redirects, foreign paths, unverified TLS and bodies above 65,536 bytes. There is no automatic retry.

## Checks and limits

Course HTTP uses only `GET /v1/student/courses/<selected UUID>`, `GET /v1/admin/courses/<selected UUID>`, and `GET /v1/student/lessons/<selected UUID>/quiz/attempts`. Valid current and configured previous baselines precede claim denials, with a final current baseline. Invalid issuer/audience/profile/version/UUID/JTI, missing fields, overlong or nonpositive lifetime, expired/future issuance, fractional time, extra PII/capability, wrong signature/algorithm, unsigned token, foreign profile/service key and invalid capabilities must refuse. Customer/admin capability separation, both cross-course directions and completed-attempt isolation must pass their exact statuses and identities. No generic “any non-200” rule exists.

Both APIs also execute their actual verifier modules inside the selected images. The Community receipt is explicitly **verifier-only**: Community exposes no member read route, so this tool introduces none and makes no claim about an invented member domain. Fixed module byte hashes and actual parsed runtime configuration are retained. The factories additionally check a fixed reference clock at 29/31-second expiry and 31-second future issuance boundaries. Those are deterministic code checks, not measured deployed revocation duration or a changed server clock.

Current-only configuration is distinct from overlap. No key is removed or rotated; `keyRemovalVerified` stays false. Removal requires the separate deliberate reviewed configuration stage and its own actual denial evidence. Protected frontend workload/OIDC and external ingress are separate checks: every result keeps `oidcVerified: false`. This direct private TLS path does not prove OIDC. Session/provider behavior, receiver lifecycle effects and S13's measured outstanding authorization/playback duration remain outside this tool.

On success, `P2_STAGING_IDENTITY_NEGATIVE_PROBES_PASS` contains only source/candidate/configuration identities, selected container references, named check/status records and hashes. `releaseAccepted` remains false. Failures raise `NegativeProbeFailure`; its `public_receipt` is safe for the broker to persist. The exception text is fixed. Unknown output or a malformed/partial/mismatched check manifest refuses rather than exposing diagnostics. The driver must require the exact pass status and retain failed attempts.

## Owned verification

Run Node fixtures with explicit exact-source compiled API directories:

```sh
P2_IDENTITY_COURSE_RUNTIME_DIR=/absolute/qualified-course-source \
P2_IDENTITY_COMMUNITY_RUNTIME_DIR=/absolute/qualified-community-source \
node --test ops/platform/p2-identity-negative-probe.test.mjs
cd ops/platform/host
python3 -m unittest p2_identity_negative_probe_test -v
```

The owned fixtures verify API Git heads against the selected contract pins and compare compiled modules with in-memory compilation using each API's actual compiler settings. They run actual Course app/auth/student/quiz modules behind owned verified HTTPS, with immutable in-memory business records and synthetic keys. They do not use live SQL or deployed images. Missing runtime directories cause an explicit optional-fixture skip, never a deployed qualification. Host tests cover actual plan parsing and private bridge/receipt guards with owned test seams; the complete Linux broker/container continuation remains unexecuted locally because no Docker daemon is available.
