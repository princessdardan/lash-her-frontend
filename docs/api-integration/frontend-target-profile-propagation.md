# Frontend database target-profile propagation

The profiled source context is the separately supplied registered `staging-current` reference. Only `undefined` selects the existing legacy path. A missing, null, unknown or mismatched context cannot select a fallback. This metadata identifies policy; it does not prove database, role, provider, host or release authority.

The canonical reference remains version 1, ID `staging-current`, digest `ea88751524540bfe177e089680b41d6f35b2454d73d17ef9a40b7663381225ba`. No isolated or production profile is registered.

## Entry points

| Function | Explicit source context position |
| --- | --- |
| `prepareFrontendMigration(candidate, job, baseline, artifact, expectedProfile)` | Fifth; the default artifact read is deferred until context and carrier checks succeed |
| `prepareFrontendMigrationJob(candidate, settings, schemaExport, stagingVerification, expectedProfile)` | Fifth |
| `runFrontendMigration(prepared, dependencies, expectedProfile)` | Third; revalidates the prepared carriers before effect hooks |
| `prepareFrontendRolesPlan(candidate, job, specification, expectedProfile)` | Fourth |
| `applyPreparedFrontendRoles(plan, client, dependencies, expectedProfile)` | Fourth; requires the genuine branded plan |
| `readFrontendRolesMigrationCredential(directory, expectedProfile)` | Second; resolves context before private-file access |
| `prepareFrontendAdmissionBootstrap(input, expectedProfile)` | Second |
| `bootstrapFrontendAdmission(input, client, dependencies, expectedProfile)` | Fourth |
| `prepareFrontendReleaseInventory(input, migration, source, expectedProfile)` | Fourth |
| `prepareFrontendReleaseRoleTemplate(input, migration, source, expectedProfile)` | Fourth |
| `validateFrontendFenceObservation(plan, nonce, observed, retain, options, expectedProfile)` | Sixth |
| `prepareFrontendReleaseCoordination(candidate, job, baseline, inventory, source, expectedProfile)` | Sixth; default source inventory is deferred |
| `runFrontendReleaseCoordination(prepared, dependencies, expectedProfile)` | Third |
| `prepareFrontendRestoration(input, expectedProfile)` | Second |
| `restoreFrontendAdmission(plan, client, epoch, dependencies, expectedProfile)` | Fifth |

Programmatic callers select context in their fixed source entry point before decoding carrier JSON. The context is never obtained from the input's version or profile field. The migration CLI's existing `--check` and `--execute` remain legacy-only. Fixed `--check-profiled-current` and `--execute-profiled-current` resolve the registered constant before reading input files. Raw carrier JSON is decoded with the shared bounded, duplicate-refusing decoder.

## Versions and identity

Legacy candidate version 2 and frontend job version 1 retain their original unprofiled records. The profiled path requires candidate version 3, frontend job version 2, and the same reference on the candidate, its frontend migration projection, the job and its unversioned target. Job preparation also requires the reference on unversioned frontend target settings. The prepared migration wrapper is unversioned and carries the reference.

Role specifications/plans, role public/private generated records, admission bootstrap plans/receipts, inventory plans, restoration selections/receipts and migration/continuation/finalization receipts use version 2 in the profiled path. Existing unversioned records remain unversioned and gain the required reference only when newly issued in the profiled action. In particular, the migration CLI's started record is not assigned an invented version.

SQL artifacts, schema baselines, catalogs, SQL text and journal digests remain ref-free and unchanged. Physical admission target hashes retain their original preimage. Actual role OIDs are still observed from PostgreSQL; a profile contains no preallocated OIDs. Public HTTP, JWT, enrollment, runtime feature, consent and commerce contracts are unchanged.

Profiled role reuse authenticates the original public proof, its expected proof hash, versions, profile, target, role names and OIDs, and the private record's exact original plan hash before any verification callback, database query or new intent. The authenticated pair is retained in process for subsequent physical checks. A same-profile, same-target private record from another genuine action is insufficient even if its credential still authenticates. Legacy reuse keeps its existing behavior.

## Deliberately unavailable execution

**Profiled pending frontend SQL is refused unconditionally**, including programmatic calls with callable or no-op preflight/continuation functions. The leaf `--execute-profiled-current` supports only server-enforced current/read-only jobs. There is no callback, serialized flag or standalone pending-apply bypass. A future pending path requires a reviewed, unforgeable parent authority; this package creates none.

Pure version 2 inventory preparation uses the genuine profile-aware historical-login and bootstrap-compatibility helpers. Complete profiled `runFrontendReleaseCoordination` execution remains refused before receipt stores, credential acquisition, locks, clients or database work. Provider/admission/host observers, outer execution and their retained receipts still need coordinated source integration. Removing that refusal alone would not implement their required context, version or authority joins.

Existing independent bootstrap components retain their actual TLS, session, lock, OID, membership, ACL, GUC, schema and receipt checks. Their owned fixture results do not establish whole-environment virgin-install authority. Current policy cannot authorize that separate factory.

## Qualification scope

The source change is exercised with focused Node 24 tests and disposable PostgreSQL 16/18 fixtures. The owned role fixture creates fresh observed roles, verifies genuine v2 reuse and refuses swapped or legacy receipt pairs before effects. The migration fixture verifies actual profiled read-only CLI receipts after applying the existing 83-migration chain, then proves pending execution creates no intent and leaves the actual journal/schema unchanged. The restoration fixture exercises actual closed admission bootstrap and ordered restoration under TLS and physical/environment locks, including a lost-commit acknowledgement with uncertainty retained.

Fixture candidate/source/image selectors are synthetic. Provider boundary observations use the existing owned server. No Docker, live provider, candidate publication, allocated resources or staging/production release is qualified by these local records. Original source `663c182fb9c79ae788bf694c8886ca6265d38594` and its pre-correction evidence are preserved; the pending-authority and private-plan-pair findings are corrected separately in `df81897327086021bdf4dfa12e6a1f53e249f33a`.
