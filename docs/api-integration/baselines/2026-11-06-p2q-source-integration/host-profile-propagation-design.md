# Host, gateway and application qualification-profile propagation

Status: source interface design, not implemented-host or deployed qualification. No resources, credentials, provider calls, database connections or repository edits were used for this design.

## 1. Fixed source and already agreed contracts

Reviewed frontend foundation: `5e007c4447cb1070c8718fa16bb0ca73e0b69213`. Course: `0bb054d5a04db71c481a8b3d182db6df19782cdc`. Community: `8594d953a5c0e0849e7a2e5e0de21f03537c4dc4`. Both API worktrees were at those exact merged commits; their inspected operator-module blobs matched those commits. The earlier a447/939 API and 3d92 frontend seams are historical baselines, not the proposed executable pins.

This extends interface revision 3, `/private/tmp/p2q-interface-freeze-20261106/design.md`, SHA256 `af863c7b4a3b99a7492c9d0b73d306f42d5ce413ebe2b077387cab662e41e1d3`. It does not change its canonicalization, errors, carrier field, current body or hash.

The only registered reference is the closed object:

```json
{"version":1,"id":"staging-current","sha256":"ea88751524540bfe177e089680b41d6f35b2454d73d17ef9a40b7663381225ba"}
```

`qualificationTargetProfile` always means this atomic reference, not a loose ID, a deployment observation, a credential/custody certificate, or the unrelated existing `certification.profile`/fault-lease `profile` fields. Do not rename or reuse those feature/fault selectors.

The current definition binds its existing-staging policy plus known Vercel team/project, canonical browser origin and public gateway origin. It intentionally does not invent missing database, machine or provider IDs. Exact jobs, actual TLS identities, roles/OIDs, host/container/process/configuration proofs and historical/provider evidence remain independently mandatory. `p2q-20261106` is absent; resolving it refuses before private input or external work. Current policy cannot authorize whole-environment virgin installation. Existing separately approved true-empty database primitives keep their full-chain/true-empty/postflight-false behavior; they do not become virgin-environment authority.

## 2. Source-selected context and raw boundaries

Use explicit keyword `expected_profile=None` on host functions; never infer it from a candidate, job, receipt, JSON `mode`, schema version, environment variable or available registry entry. `None` means the fixed legacy-only path. A non-None value must resolve through the installed source-owned registry and match every normative carrier. A malformed/unknown/mismatched value refuses; it is never converted to None. Copy the resolved reference into process-local state; serialize a plain closed dictionary when a new receipt requires it.

At a CLI, exact source command selection resolves the literal current constant before reading any manifest or stdin. A supplied JSON reference only joins that source decision. It cannot select policy. At a programmatic boundary, the reviewed caller supplies the explicit expected reference separately from carriers. Existing private factory/WeakMap/class/physical-session authority remains necessary; a reference is not a new capability.

Use `decode_qualification_target_json(raw, "carrier")` for new profiled candidate/job/receipt JSON and `"private-packet"` for profiled initial/IPC packets, before value/schema checks. Preserve the stricter existing per-file/frame bounds, even when the generic decoder permits more. Secure regular-file/NOFOLLOW/NONBLOCK reads remain required. Duplicate decoded keys, invalid UTF-8, noncanonical numeric tokens at profile.version, overflow, excessive depth and malformed kinds refuse before data-dependent hooks or external work. The fixed registry remains source-only. Legacy successful output bytes and legacy source selection stay unchanged; add explicit rejection of profile-bearing/new-version normative input at legacy boundaries rather than accepting unknown fields.

The existing Python module exports are the only profile codec/resolver primitives:

* `parse_qualification_target_profile_ref(value)`
* `resolve_qualification_target_profile(ref)`
* `require_qualification_target_profile(expected, *carrier_objects)`; at least one actual carrier, never zero
* `decode_qualification_target_json(raw, kind)`
* `STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE`

Do not change these to consume direct refs in place of carrier objects. Keep the fixed `QUALIFICATION_TARGET_PROFILE_{REFUSED,UNKNOWN,DIGEST_MISMATCH,REQUIRED,MISMATCH,POLICY_REFUSED}` codes and `QUALIFICATION_TARGET_OBSERVATION_MISMATCH`; retain existing more specific host/SQL/source errors. Missing profiled carrier: REQUIRED. Registered but different ref: MISMATCH. A legacy action receiving profiled execution or an unavailable source graph: POLICY_REFUSED. Physical target/source/configuration contradiction: existing exact guard or OBSERVATION_MISMATCH. No exception text, private values or new credential-derived hashes enter common output.

## 3. Fixed command map

These are source selections, not new approval steps. Plan remains default; existing apply/confirmation rules remain required. No command accepts an arbitrary profile ID, layout, program, observer, callback or target override.

| Program / source caller | Existing invocation | New profiled-current invocation |
| --- | --- | --- |
| Both API migration images, `dist-migration/scripts/run-operator-migration.js` | `--check` / `--execute` accepts legacy manifest1/target1 only | `--check-profiled-current` / `--execute-profiled-current`, already source implemented in merged APIs, accepts manifest2/target2 only |
| FE migration image, `ops/platform/frontend-image.mjs` -> `frontendMigrationCli` | Existing `--check` / `--execute`, legacy only | Same two `*-profiled-current` verbs; leaf execute remains verify-current-only. Pending SQL requires the actual profiled coordinating scope, not this CLI |
| `host/migrate.py`, `host/release.py` | Existing arguments and default plan/apply semantics, legacy only | Add literal `--profiled-current` to the same fixed entrypoint; resolve before bundle reads. This does not authorize standalone pending FE SQL |
| `host/p2_release_supervisor.py` | No additional argument; legacy initial1 | Exact argv `['--profiled-current']`, source-selected expected current and initial2 before calling `supervise` |
| Source-mounted `host/database_current.mjs` | Existing two fixed file arguments | Leading literal `--profiled-current`; resolve current before reading the job or private stdin; call API prepare with explicit expected context |
| Fixed FE physical/current observer programs | Existing source-selected launch, request1 | Leading literal `--profiled-current`, source-selected context before decoding request2; no body-selected mode switch to profile policy |
| Recovery/certification/rotation/C and standalone identity/persistence/receiver host entries | Existing exact entry/type/layout rules remain legacy only | No profiled execution until that entire action's source graph is implemented and reviewed. A later explicit fixed-current verb must resolve before input, never reuse legacy main by stripping fields |

The Node preparation owner's `migrationOperatorCommand(expectedRef, action)` is the authoritative agreed semantic table for image check/execute verbs: absent -> existing, exact current -> profiled-current. Python `docker_arguments` mirrors that finite table and tests parity. It never examines `job.schemaVersion` to choose a command. New Node outer transport must select its matching fixed host argv from the separately validated expected context, then join the initial packet; private JSON cannot choose it.

## 4. Carrier and receipt version table

Versions are per existing type, not a universal envelope added to every JSON object.

| Carrier | Legacy unchanged | New profiled carrier |
| --- | --- | --- |
| Release candidate | `version:2`, profile absent | `version:3` + ref; exact joins on sourceApproval, integration, each sources[name] projection, workload, approval, and frontendMigration when present, as candidate owner specifies |
| API approved target / operator job | `schemaVersion:1`, profile absent | `schemaVersion:2` + ref on both; non-null stagingVerification also joined |
| API internal migration release plan | Existing unversioned | `schemaVersion:2` + ref |
| API normative database receipt | `schemaVersion:1` | `schemaVersion:2` + ref; actual source/image/SQL/schema/target and paired terminal still mandatory |
| API role policy context | Existing exact service/environment keys | Exact service/environment/qualificationTargetProfile keys; no invented context schemaVersion |
| API CLI status/started/job-outcome | Existing source-specific shape | Actual merged Course source emits unversioned + ref; Community emits schemaVersion2 + ref. Do not require a fabricated common version. Validate per-service source schema, exact ref and the normative DB receipt; do not downcast either |
| FE migration job / DB receipt / versioned continuation/finalization | `version:1` | `version:2` + ref; FE target/settings remain unversioned with mandatory ref, not a fabricated target schemaVersion |
| SQL artifact, journal, schema baseline | Existing versions/digests | Unchanged. They describe SQL/schema content, not deployment policy |
| FE role, bootstrap, inventory, fence, coordination and restoration plans/receipts | Existing version1 | Version2 + ref, as FE DB owner's seam table; private generated credential records join too |
| Host-only `configuration/runtime.json` selector | Existing version1 | Version2 + ref; same existing hostMachineId/release/environment/recovery fields |
| Host initial private packet | Existing version1 | Version2 + ref plus existing candidate/job/source/target/configuration/credential fields |
| Newly produced host migration/runtime/current/staging aggregate outcomes | Existing unversioned outcomes remain byte-identical | New `version:2` + ref. Do not call the legacy unversioned form version1 or rewrite it |
| New host public plan | Existing exact fields | New version2 + ref, credentialsRead/traffic/release acceptance semantics unchanged |
| Receipt-bearing IPC and physical observer request/result | Existing frame/request fields | Profiled stream has ref on commands/responses; versioned request/result1 becomes2. Existing transport id/status fields retain meaning. Internal health/alive pipe need not invent a new JSON authority field; it remains bound to the one initialized process-local context |
| Unchanged gateway/TLS configuration and gateway admission state | Existing bytes/schema | No added profile fields. Host selector and newly generated wrapper/observation receipts bind them externally |
| Immutable historical/C/B/rotation receipts and source manifests | Original bytes/hash/schema | Never reserialized, relabeled, stamped, silently accepted as new profiled execution completion, or assigned a new meaning |

Top-level input3 does not excuse a missing nested ref. New job2 with an old result, candidate3 with any job1, a profiled expected context with candidate2, or any foreign registered ref must refuse before credentials/client construction, lock acquisition, provider requests, child execution or mutation. Offline bounded input reads necessary to discover the mismatch are allowed. Emit no successful receipt from partial joins.

## 5. Exact host implementation graph and ownership

Paths below are relative to the frontend root. Root owns host/shared implementation and can subdivide it; this document grants no worker ownership of shared edits. Candidate/preparation owner is `p2_role_review`; FE DB owner is `p2_release_driver`. Existing specialist scopes remain unchanged.

| Files / current seam | Required profile propagation / ownership |
| --- | --- |
| `ops/platform/release.mjs`, `prepare-migrations.mjs` | Candidate owner: candidate3 strict validation, source-selected command helper, API job2/target2 preparation, no default/inference. Fixed profiled-current preparation wrapper resolves before raw reads |
| `frontend-migration.mjs`, `frontend-image.mjs`, frontend role/admission/inventory/coordinator/restoration modules | FE DB owner: exact signatures in section6; independently validate prepared objects/context at run boundary before hooks/IO; refuse mixed unowned graph |
| `host/migrate.py:make_plan`, `frontend_plan` | Add keyword expected_profile. Join candidate3, all three jobs/targets, frontendMigration, approval/workload/source projections before returning jobs. Legacy requires old versions and profile absence. `make_plan` is the shared offline authority gate, not merely a permissive loader |
| `host/migrate.py:docker_arguments`, `execute` | Explicit context selects fixed image commands. Preflight all exact images network-disabled before credentials as today. Compare actual DB receipt + source-specific job-outcome ref to candidate/job. Newly emitted aggregate outcomes carry ref/version2, including known-context failure outcomes. Preserve locks, FE suspension and API-stop/prior-gateway ordering |
| `host/release.py:make_plan`, `snapshot_bundle`, `snapshot_configuration`, `_execute`, `execute` | Thread expected_profile through every reread/reconstruction and nested migrate call. Validate runtime selector2/ref, derive known project/gateway origins from definition, retain exact original raw19 configuration map, check copied bundle with the same expected context. Runtime ready/failure/started plans join ref; no field is injected into child gateway config |
| `host/p2_release_supervisor.py:main`, `supervise`, `fail_closed`, `finish_failure_cleanup` | Main selects context before decode; supervise passes fixed context to migrate and exact source-selected Broker/observer classes before fork. Cache only source-derived context with existing observer/configuration evidence. Both cleanup passes preserve that context, exact layout and source-selected containment callback. No user-defined `_guard*` profile/layout survives startup |
| `host/p2_release_broker.py:Broker.__init__`, `select_release`, `initialize`, `start`, `check`, `verify_promoted`, terminal/commit | Store explicit expected_profile; reject mixed initial/candidate/job/runtime/FE receipt at selection before private credentials or host flock. Forward context to runtime.execute, scope and observer. Startup LOCKED/receipt-bearing frames join context. Rechecks compare actual raw bindings, not merely the ref. Preserve actual guardian/type identity, heartbeat, source closure, registered children and terminal-before-commit lifecycle |
| `host/p2_release_scope.py:P2ReleaseScope` | Add keyword expected_profile; copy resolved ref with selected release/jobs/configuration. `require_release`, `require_frontend`, and configuration/physical joins reject missing/foreign context. Same actual FD/frontend physical session/private nonce/registered process lifetime remains the authority; no JSON constructible alternative |
| `host/current_databases.py:check_all`, `host/database_current.mjs:main/checkCurrentDatabase` | Add separately supplied expected context and fixed child flag. Match all jobs and source-generated FE/API current receipts before aggregate PASS. Do not infer profile from manifest; preserve read-only role/TLS/schema/journal checks and exact image/private stdin cleanup |
| `p2-frontend-live-probe.mjs`, `p2-recovery-current-probe.mjs`, `p2-recovery-api-current-probe.mjs`, `p2-certification-current-probe.mjs` | Root/assigned observer owner: request2 and output2/ref from actual source-selected observer context, input job/receipt/plan joined before connection or fence SQL. Physical guard verifies backend PID/start/nonce/locks/role/OID/schema as today. Ref equality does not replace those observations |
| `host/staging_state.py:retained_state/configuration_hashes/restored_configuration` | Same-context retained outcomes/DB receipts/runtime selector required for profiled restoration. Keep original19-name configuration map and existing raw/canonical hash meanings. Different-host restoration remains an explicit new-machine action, not policy-digest approval |
| `host/runtime_actions.py:RuntimeOperator`, `staging_release.py`, `staging_recovery.py`, `staging_restore.py`, `staging_frontend_restore.py`, `staging_rollback.py`, `staging_retire.py` | Root: new profile-aware entry source context must flow through all planning/current/readback/runtime/provider continuations. Until assigned and complete these remain explicit legacy-only actions; do not let a lenient downstream make_plan select policy. P1 acceptance in staging_admission.make_plan is not a new G2 acceptance path |
| `host/staging_admission.py:Host/persist_state`, `frontend_gateway_observation.py`, `p2_prior_gateway.py` | Gateway schemas stay unchanged. Profiled host wrappers bind source context + exact candidate/raw config/mount/process/admission hash/epoch/counters. Current prior evidence adapter in section8 must be explicit; no missing/unknown/newer lineage becomes zero |
| `host/vercel.py:release_identity`, `_project`, stage/promote/disable helpers; `frontend_probe.py`, `p2_canonical_browser_origin.py`, `native_qualification.py` | Resolve source context first. Current ref must match actual fixed team/project/canonical/public origin while existing repo/source/deployment/challenge/expiry/native constraints remain. Parent wrapper produces new profiled observation over unchanged authenticated HTTP response; do not alter protected/public HTTP just to transport profile metadata |
| `host/p2_recovery_broker.py`, `p2_recovery_scope.py`, `p2_recovery_runtime.py`, `p2_recovery_supervisor.py` | Existing fixed current-only recovery remains legacy. A future explicit profiled-current recovery requires new receipt-producing/consuming graph and current physical observer; no legacy DB receipt adoption |
| `host/p2_certification_parent.py`, `p2_certification_fault.py`, `p2_known_ack_loss.py`, `p2_known_ack_interrupted_restoration.py` and their Node transports/controllers | Preserve feature/fault profiles, C original installed source/readback/frontiers, B atomic authorization, causal hashes, one-use consumed capabilities, exact temporal fences. Profiled execution initially unavailable. New variants must join all causal/retained scope records, never strip metadata to call old live executors or rewrite original receipt/source hashes |
| `host/p2_identity_key_rotation_parent.py`, `p2_identity_key_rotation_adapter.py`, Node rotation controller/transport | Preserve existing configuration-phase/private hash, epoch/window/token chronology and retained source bindings. Explicit legacy-only initially; no new profile can be inferred from phase config, browser origin or supplied JSON evidence |
| Standalone identity/persistence/receiver/authority-timing scopes and entries | Root/assigned certification owners: fresh profiled selection and exact existing host/current bindings needed before read-only/POST child work. Existing v1 reviewed plan/capture/receipt parsers remain legacy; no profiled PASS until source producer and consumer versions agree. Keep each tool's actual write scope accurately labeled |
| `host/p2_source_closure.py`, `recreation_source.mjs`, `recreation_ssh.mjs`, installed source caches | Existing full closure/count/byte rules unchanged. Profiled actions additionally require actual installed registry/helper bytes in their own authenticated source map. Do not add new mandatory anchors retroactively to legacy original-source closure validators used by C or historical receipt replay |

## 6. Node owner handoff signatures

Candidate owner confirmed `validatePlatformRelease(value, now, expectedRef?)`, `prepareProfiledCurrentMigrationBundle(...)` (fixed source current) and `migrationOperatorCommand(expectedRef, action)`. Legacy `prepareMigrationBundle(...)` remains legacy-only. Candidate3 carries exact ref projections listed above.

FE DB owner confirmed the explicit expected argument positions, with default source/artifact reads deferred until context/carrier checks:

* `prepareFrontendMigration(candidate, job, baseline, artifact=undefined, expectedRef?)` and `prepareFrontendMigrationJob(candidate, settings, schemaExport, prior=undefined, expectedRef?)`: fifth argument.
* `runFrontendMigration(prepared, deps, expectedRef?)`: third.
* Roles prepare/apply: fourth; private credential reader: second.
* Bootstrap prepare: second; run: fourth.
* Inventory/desired-role template: fourth.
* Fence validation: sixth, after existing fifth options.
* Coordination prepare: sixth, after deferred fifth source; run: third.
* Restoration prepare: second; run: fifth.

Host additions use keyword expected_profile to avoid shifting existing positional apply/lock/callback parameters. New `expected_profile` on make_plan/execute/constructor calls is separately supplied from the source-selected parent, not harvested from returned plan fields. Any source-issued capability/prepared object must bind this context and revalidate it at run time; a new ref on caller JSON alone is insufficient.

The currently unowned `frontend-historical-logins.mjs`, `frontend-bootstrap-compatibility.mjs`, `frontend-release-adapters.mjs`, provider/historical observer envelopes and outer P2/recovery host transports are explicit integration blockers for a positive profiled coordinating action. Assign these before enabling one. Do not implement a JSON `graphComplete:true`, a caller-provided verifier or a permissive fallback. A fixed source graph that lacks a required adapter returns POLICY_REFUSED before credential reads, DB work, provider requests or child launch.

## 7. Gateway/runtime binding without PR91 changes

Use `runtime.json` as the host-only versioned wrapper. It already belongs to the retained configuration19 map and is not a gateway API schema. Version2 adds the exact ref; all original target/recovery fields retain their requirements. No new sidecar or twentieth runtime file is required. The profile's known origin/project fields must match the separately parsed existing gateway.json fields; unknown actual machine/DB IDs are not filled from policy.

Keep `gateway.json`, course/community TLS policy JSON, admission/state.json, seven private env files, certificates, compose topology and all `ops/gateway/runtime/**` bytes unchanged. Host planning joins the candidate/profile, raw gateway/TLS/compose identities and runtime selector. Fresh actual observer wrappers join the exact mounted files, container IDs/images/security, gateway process binding, admission counters/epoch/state digest and source-selected host. This binds unchanged runtime configuration without teaching the runtime a new trusted field.

No wrapper may claim configuration readback from a public hash or file path alone. It must execute the existing source-owned actual mounted/process observation under its checked scope. The ref appears only in a newly produced host/operator observation with those original bytes/results bound; it is never inserted into the unchanged gateway/native proof to make a legacy proof look new. Keep existing gateway process hash semantics (bootId/PID/startTicks), raw configuration file hashes and insertion-order/canonical hashes distinct. Existing private configuration19 hashes stay private wherever currently private; no new credential hash publication.

The physical FE admission target digest continues to hash its existing explicit physical projection (environment, host, port, database, user, serverMajor). The profile reference is an independent required join. Do not append it to that hash input, repurpose a prior target digest as a profile digest, or change actual lock/role/nonce semantics.

## 8. Legacy and historical compatibility

Unchanged legacy action -> unchanged candidate2/jobs1/runtime1/legacy receipts and current guards. It rejects new profile-bearing execution input. Explicit profiled action -> new versions and exact ref through every normative executable carrier; missing old DB/runtime completion is not rescued by current ref equality.

Historical source profiles, original deployment configuration/catalog evidence, prior P1/G1 receipts and C original B receipts remain their original schemas, source hashes and bytes. A profiled new release may reference them as historical evidence only through a reviewed source-owned read-only adapter that understands their original type and exact source semantics. It must retain original raw bytes/hash and emit a NEW observation from fresh checked current state; attaching metadata after a legacy mutating executor is prohibited.

For the practical current-staging transition, define a dedicated adapter operation `observe_legacy_current_prior(...)` (name frozen here; implementation still required). Its source caller has already resolved literal staging-current; it accepts only the existing explicit original candidate/configuration/receipt reference types, validates them with their original source/schema and raw hash, performs the actual current/stopped prior-gateway observation with complete latest lineage/process/mount/counter checks, and issues a new version2/ref observation labeled `legacyCurrentPriorObserved:true`. It does not emit a profiled database-completion receipt, claim the old candidate was version3, establish original credential history, authorize replay, or substitute old1 for an unknown later gateway. Its return must remain process-local/source-issued where the prior boundary currently requires that authority. A new public JSON boolean is not this adapter. If unavailable, profiled action refuses before locking/mutation. Existing legacy release/recovery still functions.

An isolated-allocated target cannot use this adapter to adopt current staging DB/runtime/provider evidence. The current profile cannot be silently rewritten to the isolated profile. If future changed-resource restoration is required, a distinct approved registered-source selector plus actual fresh target/control/credential evidence and an explicit source transition is needed. No such positive authority is implemented by this design.

## 9. App and build environment seams

Current source already fixes Vercel identities in `src/lib/env/application-environment.mjs`; `getApplicationEnvironment()` is the server wrapper. `scripts/validate-sanity-env.mjs`, `src/lib/api-integration/gateway-transport.ts`, customer auth, protected release-probe and canonical-alias helpers consume those environment/origin decisions. Root owns their eventual source wiring.

A future closed deployment selector maps actual verified platform context (team/project/workload target) to an already registered source definition. It must refuse an unknown staging project; APP_ENV, browser input, a profile ID in env, an arbitrary bindings override or a private target JSON file cannot authorize a new project. Preserve existing production and local paths; there is no new production qualification profile. Local/preview classification never grants gateway OIDC authorization. Hosted expected IDs are still checked separately against actual OIDC/deployment/project/source receipts.

Do not import the filesystem-loading ops registry into browser code. Use a source-generated, reviewed app projection of only the closed nonsecret deployment mapping, with source tests proving it matches the canonical source registry/current bindings. Source generation/build command and exact project mapping, not runtime strings, choose policy. Before isolated allocation the mapping contains current only and existing production/local policy remains unchanged. Future real IDs require committed source changes, CI and new artifacts.

Customer/admin canonical URLs, gateway origin and Sanity public project/dataset must pass the selected source policy before outbound work. The current profile leaves its existing Sanity/provider source bindings in force; it does not certify omitted original credentials or fetch irrelevant system secrets. No new public HTTP field, JWT claim, service credential, endpoint, topology, token lifetime, workload quota or probe expiry is introduced. Use the existing authenticated challenge response unchanged and produce profile-aware operator wrappers joining actual project/source/alias/challenge/configuration evidence externally.

## 10. Required implementation order and test gates

1. Candidate/preparation and FE leaves can land independently with explicit mixed-graph refusal. Keep old entry source behavior and successful legacy receipt bytes covered by golden tests.
2. Root propagates host make_plan/runtime/current/image-command gates and host-only runtime selector2. Tests must reject stripped candidate3 -> candidate2 in a fixed profiled action, all candidate/job/target/receipt mixed versions, missing/foreign refs, wrong registry hash, malformed raw duplicate/version/UTF8/depth inputs before any credential/client/lock/provider/child hook.
3. Propagate supervisor/Broker/scope and exact physical observer programs as one reviewed graph. Test actual fixed CLI `-I` module identity; both processes retain the same actual FD/source context; cross-context receipt, nonce, target, source/mount/config/container/OID drift and process loss contain. Failed input does not skip fixed existing cleanup. Unknown readback stays unknown; no profile error permits reopening.
4. Implement and test the explicit current-only historical/prior adapters and the unowned FE dependency seams. Original fixture versions/hashes are retained. New observations must use real owned PG/HTTPS/process evidence; synthetic refs or callbacks cannot mint positive authority.
5. Profiled restoration/certification/rotation/B/C paths remain unavailable until their own complete graph is assigned and reviewed; strict refusal is interim status, not completion. Preserve all legacy tests and source-byte/hash checks, especially causal C/B and last-qualified rotation semantics.
6. Rerun affected exact-source CI/image/source packaging, observe the final committed source producer/encoded envelope within 512/41 MB/56 MB/per-file2 MB/private24 MB, and verify PR91 runtime tree equality. No source changes in this design count as published matching artifacts or live qualification.

## 11. Decisions and remaining implementation tradeoffs

Decisions frozen for ownership coordination: atomic field/hash/errors unchanged; explicit source-selected optional expected context; fixed current command map; strict new-vs-legacy versions; host-only runtime selector2 instead of runtime/core schema edits; original19 configuration/hash meanings retained; no retroactive source anchors/receipt restamping; app mapping source-selected from actual platform identity; unsupported mixed action graphs refuse before external/credential work.

Implementation choices still requiring root integration review: how to share Python context/version predicates without a new authority class; the exact assigned file list for currently unowned historical/provider adapter producers; app projection generation location/build integration; whether to enable only profiled offline/check/current leaves first or finish the complete current coordinating graph before exposing its apply verb. These choices cannot weaken any join above or introduce a caller-selected execution mode. The current-only prior observation adapter is required for profiled use of old current-staging history and must be implemented/tested, not waived.

The resource/provider creation-control/custody/no-delivery authority specification remains a separate open handoff at `/private/tmp/p2q-creation-authority-spec-20261106/design.md`. This host propagation document neither redesigns nor supplies that factory. Current registry and observation-only first-install collectors cannot mint isolated first-use authority, authorize allocation or complete G1/G2.
