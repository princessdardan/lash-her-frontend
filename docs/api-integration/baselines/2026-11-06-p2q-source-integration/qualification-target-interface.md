# P2Q target-profile interface freeze, version 1

2026-11-06. Read-only interface design, revision 3. The user authorized the revised scope and source implementation. Resource allocation, spending, candidate publication, credential/provider work, deployment and live certification remain unauthorized. This document freezes source interfaces; it supplies no target or release authority.

Reviewed baselines: frontend `3d92f1b8579e9dc8076cc188e3624869700e0e4d`, Course `a447bfde20299e12afab68a3331b3792ddd07598`, Community `939de65dd52f0b1a43993a25c7c428dce6e2bb43`. The updated source-seam report is `/private/tmp/p2-isolated-target-seams-20261106/report.md` (SHA256 `1cbad6f9323da37c8ce8768a367e745bfb0008171e953b6c9ae3a3a5eb970c69`). Its policy corrections remain mandatory: no extra approval ceremony; observed role OIDs are not precreation profile inputs; changed executable source requires new source/CI/images.

## 1. Frozen carrier

Every new profiled carrier contains exactly one field:

```ts
type QualificationTargetProfileRef = Readonly<{
  version: 1;
  id: string;
  sha256: string;
}>;
// carrier.qualificationTargetProfile: QualificationTargetProfileRef
```

The reference object has exactly those three own keys. No null, array, inherited property, unknown key, partial reference, coercion or default is accepted. `version` is integer 1 (Python bool is rejected). `id` matches `[a-z][a-z0-9-]{0,63}` and must resolve in the source registry. `sha256` is 64 nonzero lowercase hexadecimal characters, without a `sha256:` prefix. Prefix stripping/case normalization is prohibited. A reference is accepted only when its ID and digest equal the registered definition. Syntax alone is insufficient.

Use the exact field name `qualificationTargetProfile` everywhere. Do not add competing `profileId`, `profileHash`, top-level pair, `APP_ENV=p2q`, or provider-specific target maps. Existing `contractPhase`/`phase2ContractManifestSha256`, candidate/raw configuration/source/image/target hashes retain their existing meanings. Profile identity is additional, not a replacement.

## 2. Authoritative source registry and canonical digest

Frontend integration owner owns `ops/platform/qualification-target-profiles.json` and the JS consumer `ops/platform/qualification-target-profile.mjs`. Registry envelope:

```ts
{ version: 1, profiles: QualificationTargetProfileDefinition[] }
```

Envelope keys are closed. Profiles are nonempty, at most 8, sorted by `id` in ASCII code-point order, with unique IDs and unique canonical digests. No production profile is added by this package. The entire source file is authenticated by existing exact Git/source/image provenance. The per-profile digest covers one definition, so adding another profile does not alter the existing current profile's identity.

Canonicalization is deliberately a constrained cross-language JSON subset. The raw decoder below runs before decoding source JSON; value helpers do not claim to recover duplicate keys erased by another parser:

1. Validate the closed definition schema before hashing. Keys and string values are printable ASCII only; reject duplicate JSON keys before decoding, BOM, non-UTF8, surrogate/Unicode ambiguity, NaN and Infinity. Definition numbers must be nonnegative safe integers with exact type; booleans are not integers. The raw decoder requires EVERY registry numeric token and the direct `version` token inside EVERY `qualificationTargetProfile` object in a carrier/private packet to use canonical nonnegative integer grammar `0|[1-9][0-9]*`. Reject negative zero, decimal points, exponents and unsafe-range values BEFORE conversion. Thus `1.0`, `1e0` and `-0` cannot diverge between Node Number and Python float/int parsing. For raw standalone reference test vectors, wrap the reference under `qualificationTargetProfile` in a carrier. Unrelated carrier/private-packet numeric fields retain their existing schemas and are not globally restricted to integer tokens. Value helpers assume required raw decoding has already run; they still reject wrong types, Python bool and (where observable) JS negative zero.
2. Recursively sort object keys by ASCII code point. Never use locale-sensitive sorting. Preserve ordered arrays; schema-declared set arrays must already be sorted and duplicate-free.
3. Encode compact JSON with JSON string escaping, no spaces/BOM/newline. SHA256 covers exactly those UTF-8 bytes: no domain prefix, registry wrapper, Git SHA, signature, trailing newline or self-digest field.
4. Emit lowercase RAW64. The source module recomputes it and rejects a conflicting reference; do not trust a copied digest literal alone.

The current definition's exact canonical vector is `/private/tmp/p2q-interface-freeze-20261106/staging-current.canonical.json`: **371 bytes**, digest **`ea88751524540bfe177e089680b41d6f35b2454d73d17ef9a40b7663381225ba`**. The file has no trailing newline. Frozen body:

```json
{"environment":"staging","frontend":{"canonicalOrigin":"https://staging.lashher.com","projectId":"prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM","teamId":"team_2Hrn5eMZyZxfAWdmYvyKi9t3","workloadEnvironment":"production"},"gateway":{"publicOrigin":"https://api-staging.lashher.com"},"id":"staging-current","kind":"existing-staging","selectionPolicy":"existing-staging-v1","version":1}
```

For this initial entry, every value above is a literal, not a caller-variable pattern. Its definition schema has exactly the shown keys and nested keys. Initially the registry contains only this entry. `p2q-20261106` is NOT registered, including as disabled/null/incomplete data. A proposed ID or placeholder can never resolve.

This digest identifies the existing **selection policy**, not omitted/unknown actual database, host, provider, credential or historical bindings, and not live acceptance. `existing-staging-v1` means run all unchanged current source guards and actual job/runtime/host/role/provider/historical proofs. It is not an exemption from those guards and is not a virgin-install policy.

## 3. Future allocated profile: fixed boundary, no invented values

A future isolated definition must have `kind:'isolated-allocated'`, `selectionPolicy:'isolated-allocated-v1'`, `environment:'staging'`, and a separately reviewed closed resource-selector schema. It cannot use `existing-staging-v1` or derive any selector from current defaults. This initial registry deliberately does not register or accept that definition variant yet.

Its concrete definition must source-pin the real selected Vercel team/project/canonical origin, gateway origin and SSH/resource identity, three direct database/provider/database/role/owner/major policies, and selected provider-account/project/environment/client/webhook/store bindings. Required absent inputs block registration; they are not represented by guessed IDs. Optional unconfigured providers require an explicit source-defined unconfigured variant plus actual first-use absence/provenance evidence; a false flag is not capability/history closure.

The carrier and equality contract above will not change when that real definition is added. Concrete allocated-selector field details are an explicit integration-owner/resource/provider handoff before registration, because the actual provider/account/resource choices are not authorized or allocated. Consumer owners must not invent a permissive isolated-schema union, accept arbitrary `resources` maps, or expose runtime URL/role overrides now. First-install production code remains ineligible until the source registry supports and resolves a real allocated definition and the independent proof factories exist.

## 4. Selection versus observations

Static source selection binds names/identities/policies, never generated role OIDs or unobserved machine IDs. Keep selection separate from observed facts:

| Fact | Source selection | Actual observation / required join |
| --- | --- | --- |
| Frontend origin/OIDC | Exact registered team/project, workload target `production`, canonical HTTPS origin | Actual deployment/alias/protected challenge/source/workload proof before/after; no arbitrary hostname |
| Host | Current fixed transport policy, or later allocated resource/SSH identity and pinned host trust | Fresh actual machine ID, held flock FD/inode, current process/container/mount/image/config identities; bind the reviewed runtime/action and continuously recheck |
| DB | Current unchanged approved job/role policy, or later exact allocated direct endpoint/database/role/owner/major selector | Verified client TLS/CA/SNI, actual database and session identities, backend/nonce/locks, role attributes/ACLs/memberships, physical target and journal/schema |
| Role OIDs | Exact source-selected role names/policy | Observe after preparation and retain actual migration/runtime/admission-owner OIDs in the existing preparation/current receipts; subsequent checks require the same target and actual receipt, never caller OID strings alone |
| Providers | Current source policy, or future registered exact scope/binding definitions | Actual ownership/access/callback/inventory/accepted-effect proof. A selected account or source digest is not such proof |

Use existing record field names (`hostMachineId`, `ownerOid`, `runtimeOid`, existing role/target fields) rather than inventing a second generic OID/host receipt. Add the common profile reference to those source-issued records. Do not hash credential bytes or credential-file contents into public metadata. Existing private equality checks retain their scope.

An observed host identity/role OID is bound to the same profile, candidate, source, exact target and actual retained record. It is not accepted merely because a JSON field matches. First creation requires a source-owned supported collection; later reuse requires genuine original receipt bytes plus fresh readback. No inherited OID or machine identity from C07 qualifies the isolated target.

## 5. Versions and legacy compatibility

| Carrier | Existing legacy shape | New profiled shape |
| --- | --- | --- |
| Platform candidate | `version:2`, no profile | `version:3`, required profile |
| Candidate approval/integration/source proof/attestation | Existing fields under legacy candidate | Required exact candidate profile on each independently consumed projection; bump its local schema version where one exists |
| Frontend migration job | `version:1`, no profile | `version:2`, required profile; target/job/candidate equality |
| API approved target | `schemaVersion:1`, no profile | `schemaVersion:2`, required profile |
| API operator manifest | `schemaVersion:1`, no profile | `schemaVersion:2`, required profile; nested target must also be v2 and identical ref |
| API MigrationReleasePlan | **Unversioned** existing plan | `schemaVersion:2`, required profile; do NOT add schemaVersion1 to an old plan |
| API MigrationReleaseReceipt | `schemaVersion:1`, no profile | `schemaVersion:2`, required profile, including failure receipts |
| API role policy context | Exactly `{service,environment}` | Exactly `{service,environment,qualificationTargetProfile}` |
| Other internal runtime/host/role/native/browser/fault/rotation/recovery receipts | Preserve original schema/status/hash meanings | Add required profile and bump an existing local version/schemaVersion from N to N+1 where the existing schema has such a discriminator. Unversioned records remain unversioned; expected v3 candidate context requires the profile explicitly |
| OpenAPI/DTOs/enrollment event/JWT/SQL schema catalogs | Unchanged | Unchanged: this is operator metadata |

Do not bump immutable SQL artifact/catalog/journal hashes because profile metadata changed. Do not relabel old v1 contract-manifest hashes as P2 profile hashes. Profile-aware executable changes still require new exact source/image/CI provenance and candidate publication.

Legacy versus profiled action policy is selected by a FIXED SOURCE ENTRYPOINT before reading/decoding any carrier. Candidate/manifest/target versions, field absence, `allowLegacy` JSON and environment variables cannot select action mode.

Frozen API command map for BOTH repositories:

| Fixed source command | Source expected context established before raw decode | Only accepted operator/target inputs |
| --- | --- | --- |
| `--check`, `--execute` | Existing legacy-current policy; no profiled context | Legacy schemaVersion1 only, no profile field; preserve original unprofiled receipts |
| `--check-profiled-current`, `--execute-profiled-current` | Resolve literal registered `staging-current` ref before decode | Operator/target schemaVersion2, exact registered ref |

The frontend v3 coordinator chooses the new command from a closed command map AFTER its source-selected action/profile is resolved. It never chooses a command from raw manifest version. No generic `--profile-json`, unregistered isolated command or arbitrary command override is introduced. A future isolated entry must be a separately reviewed fixed registered command; none exists now.

Programmatic entrypoints take an explicit expected source context/ref, chosen by their fixed caller before decode. Absence is only the existing legacy-current code path and its parser MUST reject v2/profiled inputs; presence is only the profiled code path and MUST reject legacy/missing-profile inputs. No code reads a profile out of a carrier to manufacture its own expected context. A missing required argument on a profiled action is refusal, not a legacy fallback. Test the actual source entrypoints and coordinator command map: stripping a v2 carrier into otherwise valid v1 bytes while retaining a profiled command MUST fail before connection/query/child/provider work. Calling a legacy command with v2 MUST likewise refuse.

- Legacy parsers/verification retain exact original schemas, absence and hash meanings. Unknown/partial profile fields on legacy shapes refuse. Neither removed fields nor an inferred default change the fixed action policy.
- Legacy-current execution remains available only through the existing source-selected legacy-current entrypoint and unchanged guards. It emits original unprofiled receipts. A user choosing that separate action has not authorized a profiled action; a profiled coordinator may not invoke it.
- Profiled root contexts always require profiled jobs/targets/plans/receipts. New producers/workflows emit new versions even for `staging-current` and call the profiled source entrypoint. No parser-only legacy success grants profiled execution authority.
- Never return a reference from a missing legacy field, attach it to old bytes, or recompute/restamp an old receipt. A source-fixed legacy-current adapter may retain an original historical record and provenance; it does not produce profiled acceptance.
- Historical/recovery/retirement modules remain current-only and refuse expected isolated policy before I/O. Unsupported mixed legacy/new action graphs refuse until an intentionally reviewed adapter proves exact source/candidate/target compatibility; no automatic adoption is provided.
- Production remains its existing source-selected legacy path. No production profile is registered or enabled.

The common reference's `version:1` versions the reference format; it does not replace the carrier's own version.

## 6. Fixed APIs and cross-repository distribution

JS frontend module `ops/platform/qualification-target-profile.mjs`; API module in EACH repository `src/db/qualification-target-profile.ts`; Python host helper `ops/platform/host/qualification_target_profile.py`.

Equivalent pure exports (exact names):

```ts
export const STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE: QualificationTargetProfileRef;
decodeQualificationTargetJson(raw: string | Uint8Array, kind: "registry" | "carrier" | "private-packet"): unknown;
parseQualificationTargetProfileRef(value: unknown): QualificationTargetProfileRef;
resolveQualificationTargetProfile(ref: QualificationTargetProfileRef): Readonly<Definition>;
requireQualificationTargetProfile(expected: QualificationTargetProfileRef, ...carriers: unknown[]): QualificationTargetProfileRef;
```

Python uses the same snake_case names. `decodeQualificationTargetJson` has only three source-defined bound kinds: registry 131072 bytes, carrier 2000000 bytes, private-packet 24000000 bytes. No arbitrary bound/path argument is accepted. It checks strict UTF-8/no BOM/JSON syntax, finite input/depth (maximum128 nested arrays/objects), duplicate decoded property names in EVERY object, and the registry/profile-version canonical numeric-token rules above before any ordinary JSON.parse-style object conversion. Numeric path matching uses decoded property names, including escaped-equivalent spellings. Escaped-equivalent keys (e.g. `id` and `\u0069d`) are duplicates. The decoder preserves ordinary legitimate Unicode carrier values; the printable-ASCII definition/reference constraints apply only to those schemas. Do not globally reject Unicode private values or change existing record semantics. Never log raw bytes/token values on refusal.

The decoder returns `unknown` (the decoded JSON value), does not resolve a profile or certify a record, and throws only `QUALIFICATION_TARGET_PROFILE_REFUSED` for malformed raw input, unsupported kind, bound/UTF8/syntax/depth/duplicate-key failure. It does not print parser messages or input values. An absent/default kind is invalid. String input must round-trip strict UTF-8 without unpaired surrogates; Uint8Array/Buffer input is validated directly.

`STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE` is a deeply frozen source constant equal to the exact current reference above; its digest is recomputed from the registered source definition. Fixed profiled-current CLIs import this constant and resolve it before reading/decoding carrier bytes, rather than copying or deriving a reference from the manifest. It is policy identity, not live authority.

All source registry JSON and independently read carrier JSON boundaries must use this decoder (or an equivalent existing duplicate-detecting bounded decoder) BEFORE the value helpers. A source literal embedded/generated in TypeScript is validated as a source definition and tested against the canonical vector; there is no mutable external registry read. Fixtures must exercise real RAW duplicate-key bytes, including escaped keys and nested profile objects, not reconstructed objects. JS may use a bounded duplicate-detection token pass plus JSON.parse; Python may use strict UTF-8 plus object_pairs_hook duplicate rejection and parse_constant refusal. A reviver after JSON.parse is not sufficient. The exported value-only functions explicitly assume an already trustworthy decoded tree and cannot attest raw-key uniqueness if a caller bypassed the required decoder.

Parsing the reference validates closed shape AND registry resolution/digest (it does not return an unchecked syntactic reference). `resolve` returns a deeply frozen/copy-isolated source definition. `require` validates expected, reads each carrier's OWN `qualificationTargetProfile`, validates it, requires exact equality of all three fields and returns the verified expected reference. The exported `require` rejects zero actual carriers with QUALIFICATION_TARGET_PROFILE_REQUIRED. Resolver-only work uses `resolve` or a non-exported private helper. Authority callers must supply every independently consumed carrier; no successful zero-join call exists. No helper reads environment, URLs, credential/config files, registry path arguments, remote registries or arbitrary modules.

Frontend JSON is authoritative data owned by integration. APIs embed a generated/source-owned mirror of the exact canonical body in their new TS module, avoiding JSON COPY/runtime-resolution dependencies. They recompute the canonical digest; source tests assert the exact shared vector. Root integration compares every normalized registered definition across all three pinned sources, not only a copied SHA string. API owners do not independently add profiles or alter definition semantics. Source proof/candidate packaging authenticates registry/module bytes through the exact Git/image provenance; no externally hosted registry or signer is introduced.

Fixed error contract (nonsecret codes only):

| Code | Meaning |
| --- | --- |
| `QUALIFICATION_TARGET_PROFILE_REFUSED` | Malformed type/shape/version/encoding/hash, duplicate key, unexpected profile field on legacy shape |
| `QUALIFICATION_TARGET_PROFILE_UNKNOWN` | Unregistered ID, including `p2q-20261106` now |
| `QUALIFICATION_TARGET_PROFILE_DIGEST_MISMATCH` | Known ID with wrong canonical digest |
| `QUALIFICATION_TARGET_PROFILE_REQUIRED` | Expected profiled action received a missing/legacy profile |
| `QUALIFICATION_TARGET_PROFILE_MISMATCH` | Two individually valid references differ |
| `QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED` | Resolved policy/environment/kind cannot execute the requested operation; current profile cannot authorize virgin install |
| `QUALIFICATION_TARGET_OBSERVATION_MISMATCH` | Actual target/host/role/provider observation conflicts with the selected source policy/retained original fact |

Existing outer sanitized error mappings remain. Preserve the fixed cause internally/retained diagnostics where supported; never print inputs or raw upstream/SQL errors to add detail. Existing API error classes may carry these codes; broaden their TypeScript string union explicitly if required.

## 7. Mandatory propagation joins and owner boundaries

1. **Frontend integration owner:** registry/helper, candidate v3 + candidate approval/integration/source attestation, source-context/proof, generated API jobs, workflow artifacts and source packaging. Candidate profile equals all job refs and the selected workload project/origin; runtime configuration and source policy consumers resolve the same ref. A new profile-aware candidate cannot omit a profile because the public contract bytes did not change.
2. **Frontend bootstrap/host owner:** FE job v2, role-preparation/admission/target/current/migration/release receipts and profile ref in physical continuation/context. Retain existing locks, source handles and exact credential/SQL identity checks. Bind profile before child/DB operations. Do not make the profile an admission permit.
3. **Course and Community owners:** approved target v2; operator manifest v2; v2 plan and success/failure/authorization/current/runtime/terminal receipts; exact role context. Manifest.target/profile, plan/profile and expected source-selected context all equal before `authorize`/`createClient`/first role query. Existing `allowEmptyBootstrap`/full-chain/postflight-false semantics remain independent.
4. **Gateway/app/provider owner:** environment resolver/release probe/canonical alias, OIDC/gateway/native/browser/fault/rotation/provider selection must source-resolve the ref; do not accept a caller host or project merely because the ref matches. Public service JWTs/issuers/audiences/subjects/capabilities and TTL300/skew30/topology remain unchanged. Gateway config carries operator profile metadata; browser/public responses do not expose private configuration or service tokens.
5. **Qualification/evidence owner:** observations, plan hashes, private retained captures and final receipts include profile identity in their canonical preimages. A capture from another profile cannot mint a source handle. Old captured hashes are not recomputed/restamped. Mandatory active stage boundaries compare the expected ref plus actual immutable target/source/config/runtime/physical facts.
6. **First-install owner:** consumes a resolved *allocated* profile and independent source-issued allocation/control/first-use authority, then owns actual empty-DB/physical/host/role checks. Current profile is rejected. Actual creation/access/no-delivery proof factories belong to the resource/provider source lane with root integration; no such authentic production factory is currently established. Raw JSON booleans, a digest string or a matching registered profile cannot construct that authority. The initial production virgin path must refuse until those source-owned factories and real IDs exist. Root must assign their exact ownership/export contract; this freeze does not invent positive creation evidence.

## 8. Required source-only qualification before interface integration

- Canonical 371-byte vector agrees in Node24, Python and both API modules; key order/formatting changes do not change meaning; malformed/duplicate/non-ASCII/boolean-number/unknown-field cases refuse. Cross-language RAW registry/profile-version regressions reject `1.0`, `1e0`, `-0`, unsafe integers and Python bool while permitting schema-valid unrelated fractional carrier values.
- Current source definition and reference match exactly; unknown isolated ID refuses before any DB/client/child/provider call. A valid source definition alone never returns a live-pass receipt.
- The actual fixed legacy/profiled source commands refuse reciprocal input versions; stripping a new carrier does not change the preselected action policy. The public require helper rejects zero carriers. RAW duplicate-key tests cover registry, carrier and private packet decoding.
- Full carrier versions refuse missing/partial/extra/changed/prefixed hashes and cross-profile mixing; new candidate plus legacy target/job/receipt refuses. Legacy record bytes/hash/status remain unchanged and no profile is inferred.
- Current version/source-policy compatibility tests and accepted historical-receipt fixtures remain applicable only in their original scope. No production or old-current action path gains an isolated selection.
- Role OID/machine identity not preallocated: source role names select, actual role preparation binds observed OIDs; changed target/OID/machine/readback refuses. Actual host/physical controls remain mandatory.
- When an allocated definition is eventually registered, its different IDs/digest/roles/targets and receipts must cross-refuse against current. Tests may model this in isolated owned pure fixtures; a test registry cannot be supplied through the production CLI/environment or mint live authority.

## 9. Decisions and deliberately open implementation handoffs

Frozen now: atomic carrier, unchanged current body/digest, canonical bytes, raw decoder/export/error names, major carrier versions, fixed pre-decode source command dispatch, zero-carrier refusal, current-only compatibility, observation separation and propagation owners. Revision2 closes the three independent findings against immutable design-v1.md SHA790bfcd8cea1172e9d5530ecdcf6cf733294576473950ba14e1e60dd170cc65c. Revision3 additionally fixes the reviewer-identified cross-language numeric lexeme ambiguity against immutable design-v2.md SHAcf65634ac48f914971f3ec50fd9519b9052e7c436d2d9e56e10fb35bd8c43a90, without changing current body/ref SHA.

Open implementation choices, none permits a bypass: root may generate API mirrors or require byte-vector checks in cross-repo CI; exact wrapper-code generation is not normative. Owners must inventory and serialize local receipt-version bumps together, and report unsupported mixed legacy/new recovery graphs rather than accepting them. Root must assign actual allocation/control/provenance factories and freeze their opaque handle/retained-record schemas with the resource/provider and first-install owners. The future allocated-definition concrete selectors are frozen only after real authorized resource choices; that profile remains absent until then. No resources, secrets, cloud/provider/DB calls, publication or live qualification were performed for this design.
