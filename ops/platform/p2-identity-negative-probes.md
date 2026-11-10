# Staging deployed identity negative probes

`host/p2_identity_negative_probe.py` prepares a plan by default. Its `execute_current_stage(bundle, configuration, reviewed_probe, operator_source, prior_evidence)` runs the fixed observer under a fresh read-only host scope, after the initial release scope has closed. The lower-level `execute(..., lease)` requires that actual `CurrentIdentityProbeScope`. It creates no account, grant, assessment, progress, lifecycle command, key, schedule or provider state. No browser receives signing material. There is no token-minting or proxy endpoint.

The fixed current-stage host entry is executable independently of the initial release coordinator. Its transport wrapper is not wired by this package. Linux/container execution, final operator-source CI/publication, actual test records and deployed results remain certification gates. An owned fixture pass is not P2-12/G2 acceptance.

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
| `operatorSourceFiles`, `operatorSourceSha256` | Exact bounded public `ops/` code/config inventory from the installed committed source, mapped to byte SHA-256; hash of compact sorted ASCII JSON of that map |
| `priorEvidence` | Exactly `originalReleaseReceiptSha256` and `frontendDeploymentRecordSha256`, retaining the existing original records as provenance |
| `subjects` | Exactly `learnerA`, `learnerB`, `admin` UUIDs |
| `resources` | Exactly `courseA`, `courseB`, `sharedCourse`, `lesson`, `completedAttempt` UUIDs |
| `previousProfiles` | Sorted configured subset of `course-learner`, `course-admin`, `community-member`, `community-admin` |

There is no public key, token, URL, hostname override, path, command, callback or arbitrary header field. These bindings are prepared within the existing authorized certification scope; they add no approval/signing ceremony. Changed candidate, configuration or resources require the corresponding normal reviewed scope update.

The CLI accepts only `--bundle`, `--configuration` and `--reviewed`. It prints the plan and consumes no credentials or network capability. It has no apply flag. JSON flags cannot construct a held process-local scope.

## Guarded execution and private input

The current-stage API acquires the actual shared `/run/lock/lash-her-release.lock` on the selected Linux root host. `CurrentIdentityProbeScope` verifies that same descriptor, path/device/inode, ownership, private permissions and nonblocking flock before and after protected operations. A fixed 600-second execution budget limits this read-only run; it is not an approval expiry. It reuses `release.make_plan`, the current full runtime inventory and exact candidate/source/job bindings. The fixed public host is `api-staging.lashher.com`; private target is exclusively `https://course-tls:8443`. Production and foreign targets refuse.

This narrow lease needs no initial release process, pending migration session or frontend advisory-lock observer. It opens no database connection and has no SQL, migration, restart, admission or arbitrary-command method. It binds the supplied original release/frontend record bytes to their reviewed hashes, with `priorEvidenceBytesBound: true` and `frontendSqlVerified: false`. Existing physical frontend/deployment certification remains separate evidence. This is not a request to reapply SQL, edit pending tags, reopen a dead session or restart services.

`host/p2_identity_probe_current.py` is the fixed SSH entry. Invoke it through the existing pinned `sshCommand` transport with `sudo -n /usr/bin/python3 -I -u /opt/lash-her/operators/<exact frontend commit>/ops/platform/host/p2_identity_probe_current.py`; install the exact public committed source first using the existing `committedOperatorSource` / `installSource` handoff. The caller prepares the inventory from that same committed source; source bytes are checked again in-process before every child. There is no runtime source URL, command or signer override.

The source inventory uses the existing operator install suffixes (`.py`, `.mjs`, `.json`, `.yaml`, `.yml`, `.service`, `.timer`, `.sh`, `.guard`), with at most 400 files. It conservatively binds all such `ops/` files, including lazy/dynamic dependencies and later merged supervisor helpers, rather than assuming a fixed import count. Non-executable `ops/platform/evidence/` records are excluded. The actual installed inventory must equal the reviewed committed map exactly: missing, extra, changed or symlinked source refuses. Regenerate the map from the final merged committed source before invocation; a baseline map must never authenticate a later changed import graph.

The bounded stdin packet has exactly `version: 1`, `operation`, `bundleDirectory`, `configurationDirectory`, `reviewed`, and `priorEvidence`. `operation: "plan"` requires `priorEvidence: null` and consumes no credentials or network. The explicitly invoked `operation: "execute-current-readonly"` consumes two existing sanitized JSON records, base64 encoded under `priorEvidence.originalReleaseReceipt` and `priorEvidence.frontendDeploymentRecord`; their exact decoded bytes must match the public hashes. No key material belongs in this packet. Bundle and configuration must be private nonsymlink staging paths. An authorized certification invocation needs no extra approval click.

Operator source must be installed at `/opt/lash-her/operators/<selected frontend commit>`. Runtime input must be a private nonsymlink path beneath `/var/lib/lash-her/releases/staging`. Program bytes, original configuration digests and selected container identity are checked before and after each operation. All selected containers require read-only roots. API containers cannot overlay `/app` or modules; the gateway's only bind mounts are the exact reviewed read-only gateway configuration, admission directory and TLS directory. The full ten-service runtime inventory is checked at entry and exit.

The parent privately consumes the fixed existing `course-api.env` and `community-api.env` through the existing database-target/TLS/runtime-role parser. It reads no AWS, credential-store or secret-fetch API. AWS-held values must already have entered that reviewed runtime handoff through the existing `asm-exec` dynamic-reference mechanism, outside agent context. No new secret store is introduced.

Only the source-owned child receives the required key subset through stdin. Keys are never command arguments, files produced by this tool, receipts or logs. User/profile keys must be distinct from each other and from configured service credentials. The probe requires 32–8192-byte printable nonwhitespace key material and refuses ambiguous configuration rather than trimming it. Each API child privately compares the original configuration with its actual process and parsed runtime keys before using the actual verifier factory. The gateway child verifies actual mounted configuration and CA byte hashes. No tokens, cookies, claims, certificate bodies, connection strings, question/answer content or upstream error bodies enter common output.

The Node 24 program uses built-in crypto, filesystem and HTTPS, plus fixed imports of the actual API image's verifier/runtime modules. Its source is passed nonsecretly to the exact existing container. It assumes no host Node installation. The read-only scope registers stdin-capable children itself and imports no initial `P2ReleaseScope` or frontend SQL observer.

Each deployed HTTP child performs **one** allowlisted GET. Lease loss starts no subsequent request; an already-issued bounded read may finish. This does not claim cancellation of an in-flight effect. Children run in registered process groups; revocation/timeout kills and reaps the owned local group before releasing the lock, and uncertain cleanup refuses a pass. Docker metadata and fixed Node exec are the scope's only allowed commands. Requests reject redirects, foreign paths, unverified TLS and bodies above 65,536 bytes. There is no automatic retry.

## Checks and limits

Course HTTP uses only `GET /v1/student/courses/<selected UUID>`, `GET /v1/admin/courses/<selected UUID>`, and `GET /v1/student/lessons/<selected UUID>/quiz/attempts`. Valid current and configured previous baselines precede claim denials, with a final current baseline. Invalid issuer/audience/profile/version/UUID/JTI, missing fields, overlong or nonpositive lifetime, expired/future issuance, fractional time, extra PII/capability, wrong signature/algorithm, unsigned token, foreign profile/service key and invalid capabilities must refuse. Customer/admin capability separation, both cross-course directions and completed-attempt isolation must pass their exact statuses and identities. No generic “any non-200” rule exists.

Both APIs also execute their actual verifier modules inside the selected images. The Community receipt is explicitly **verifier-only**: Community exposes no member read route, so this tool introduces none and makes no claim about an invented member domain. Fixed module byte hashes and actual parsed runtime configuration are retained. The factories additionally check a fixed reference clock at 29/31-second expiry and 31-second future issuance boundaries. Those are deterministic code checks, not measured deployed revocation duration or a changed server clock.

Current-only configuration is distinct from overlap. No key is removed or rotated; `keyRemovalVerified` stays false. Removal requires the separate deliberate reviewed configuration stage and its own actual denial evidence. Protected frontend workload/OIDC and external ingress are separate checks: every result keeps `oidcVerified: false`. This direct private TLS path does not prove OIDC. Session/provider behavior, receiver lifecycle effects and S13's measured outstanding authorization/playback duration remain outside this tool.

On success, `P2_STAGING_IDENTITY_NEGATIVE_PROBES_PASS` contains only source/candidate/configuration identities, selected container references, named check/status records and hashes. `releaseAccepted` remains false. Failures raise `NegativeProbeFailure`; its `public_receipt` is safe for the broker to persist. The exception text is fixed. Unknown output or a malformed/partial/mismatched check manifest refuses rather than exposing diagnostics. The driver must require the exact pass status and retain failed attempts.

## Replacement frontend release

Use the same fixed host entry with a version 2 packet and the exact `staging-current` qualification profile. Use `operation: "plan-replacement"` with `priorEvidence: null` for the offline plan. For the reviewed invocation use `operation: "execute-replacement-readonly"`, the exact host `resultsDirectory` from the replacement release and the original guardian terminal and frontend promotion outcome bytes in `priorEvidence`. Keep those bytes in the private handoff. The host independently reads and joins its retained copies while holding the release flock.

Install the exact CI-qualified frontend source using `committedProfiledCurrentOperatorSource` and `installProfiledCurrentSource`. The version 2 source map uses that installed projection, excluding test files and inert `ops/platform/evidence/` records, with a 544-file ceiling. It binds the fixed provenance module and child program. In the version 2 review, include the frontend replacement target digest, the two raw API job digests in `apiJobSha256`, the full reviewed runtime inventory and gateway process digests, the replacement descriptor and the original release plan digest in `priorEvidence`.

Use `successorRuntime: null` for the original replacement runtime. After a known-acknowledgement or interrupted restoration, supply the original four-field successor reference from the guardian receipt and the selected successor configuration directory. The host verifies the original release and successor before and after the probe, including their mounts, exact runtime inventory, gateway process and closed, zero-uncertainty admission. The Community API may bind only the selected configuration's read-only CA file. The fixed child, HTTP allowlist and check set are the same as version 1. The result supplies the private S06 probe only. Public browser/cache behavior, key rotation and deployed S06 acceptance require separate evidence.

## Owned verification

Run Node fixtures with explicit exact-source compiled API directories:

```sh
P2_IDENTITY_COURSE_RUNTIME_DIR=/absolute/qualified-course-source \
P2_IDENTITY_COMMUNITY_RUNTIME_DIR=/absolute/qualified-community-source \
node --test ops/platform/p2-identity-negative-probe.test.mjs
cd ops/platform/host
python3 -m unittest p2_identity_negative_probe_test p2_identity_probe_scope_test -v
```

The owned fixtures verify API Git heads against the selected contract pins and compare compiled modules with in-memory compilation using each API's actual compiler settings. They run actual Course app/auth/student/quiz modules behind owned verified HTTPS, with immutable in-memory business records and synthetic keys. They do not use live SQL or deployed images. Missing runtime directories cause an explicit optional-fixture skip, never a deployed qualification. Host tests cover actual plan parsing, the fixed current-stage entry, private bridge/receipt guards, real POSIX flock contention/replacement and real stdin/timeout/revocation process cleanup. Linux/root target and Docker execution use explicit owned test seams in those local tests; the complete selected Linux/container invocation remains unexecuted locally because no Docker daemon is available.
