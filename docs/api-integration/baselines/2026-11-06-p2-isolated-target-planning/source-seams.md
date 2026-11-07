# Isolated P2 qualification target seam inventory

Date: 2026-11-06  
Scope: read-only source inventory. No provider, database, host, credential, or live-environment reads were performed.

## Exact source reviewed

- Frontend: `3d92f1b8579e9dc8076cc188e3624869700e0e4d`
- Course API: `a447bfde20299e12afab68a3331b3792ddd07598`
- Community API: `939de65dd52f0b1a43993a25c7c428dce6e2bb43`

## Conclusion

The isolated lane should remain business environment `staging` and Vercel workload target `production`. It needs a separate closed `qualificationTargetProfile` identity, not a third application environment and not caller-selected target fields. A source-owned registry must bind the profile name to a canonical digest and to the exact nonsecret deployment identities used by the release, database, gateway, native-cron, browser, provider, and CI gates.

The first implementation can safely add the profile schema and register only the existing staging target. The isolated profile must remain absent and refuse until its real reviewed IDs exist. Placeholders, aliases by ancestry, environment-variable overrides, or reuse of the current staging receipts must not qualify it.

A separate Linux host is the bounded implementation. The current host layer assumes one `lash-her-staging` Compose project, one public gateway host, one release root, and one `/run/lock/lash-her-release.lock`. On a separate host the same lock path and internal Compose topology remain safe. Same-host isolation would additionally require distinct Compose project, lock, release/config/result roots, certificate state, ingress port, watchdog unit, and continuous container filters across many recovery and certification modules; that is a larger project and should not be part of this lane.

## Closed target profile

Recommended public, nonsecret shape:

```text
qualificationTargetProfile = {
  version,
  id,
  businessEnvironment: "staging",
  workloadEnvironment: "production",
  frontend: { teamId, projectId, canonicalOrigin, canonicalHost },
  gateway: { publicHost, composeProject, hostMachineId },
  databases: {
    frontend: { providerIdentityRef, host, port, database, migrationRole, runtimeRole, roleOids, serverMajor },
    course:   { providerIdentityRef, host, port, database, migrationRole, runtimeRole, roleOids, serverMajor },
    community:{ providerIdentityRef, host, port, database, migrationRole, runtimeRole, roleOids, serverMajor }
  },
  providers: {
    google: { projectId, projectNumber, clientIds, allowedOrigins, callbacks },
    resend: { domainId, domainName },
    sanity: { projectId, dataset },
    mux: { organizationId, environmentId, webhookId, corsOrigin },
    square: { sandboxApplicationId, locationId, webhookId }
  }
}
```

The registry must reject unknown keys and values, derive `qualificationTargetProfileSha256` from canonical source bytes, and emit only reviewed public identifiers. Credentials, database URLs, provider tokens, webhook secrets, OAuth secrets, TLS private material, and protection bypass values remain runtime-only inputs and must never enter the registry or common receipts.

## Source seams that require named-profile support

### 1. Candidate, approval, and receipt identity

The release template currently binds only `environment`, sources, artifacts, and one Vercel workload project (`ops/platform/release.candidate.json:2-4,31-32,46-49`). `validatePlatformRelease` validates version/environment/source/artifacts but accepts any syntactically valid `prj_` workload ID (`ops/platform/release.mjs:20-27,45-65`). Add the closed profile ID and digest to the candidate, approval, host runtime plan, migration jobs, and terminal receipts. Every consumer must compare both fields exactly. Existing staging receipts must not be reusable for the isolated profile.

The immutable source repository identities remain unchanged. The three commits named above are inventory baselines, not implementation pins: profile-policy or operator changes produce new exact commits, CI evidence, images, and a new candidate. Existing immutable images may be reused only when their executable bytes and target-policy inputs are unchanged; changed executable bytes require rebuilt and re-attested images. Target selection belongs in the candidate/profile, not in mutable image tags.

### 2. Vercel, canonical browser origin, native cron, and gateway fault target

The following are exact current-target constants and must consume the closed registry rather than a runtime-provided URL or project:

- `src/lib/env/application-environment.mjs:3-14,61-90`: Vercel team/projects and Sanity projects.
- `src/app/api/internal/release-probe/handler.ts:12,20-27,49-58`: canonical authentication origin and release-probe project/gateway binding.
- `ops/platform/host/vercel.py:15-18,69-90`: Vercel team/project/repository identity.
- `ops/platform/p2-canonical-browser-origin.mjs:4-21` and `ops/platform/host/p2_canonical_browser_origin.py:21-23`: canonical alias, host, and project.
- `ops/platform/p2-lifecycle-native.mjs:11-12,52-84,151-165`: native project, cron schedule, candidate, deployment, and request observation.
- `ops/platform/p2-lifecycle-suspension-evidence.mjs:43-84,88-114`: candidate project, browser origin, host/target, and retained plan.
- `ops/gateway/p2-certification-fault.mjs:10,48-67`: project/team/public host in the source-owned fault boundary.

The cron path/schedule, fault modes, feature controls, token lifetimes, request methods, and source policies are protocol/security invariants. Profile support changes target identity only; it must not loosen those checks.

### 3. Host, Compose, gateway, TLS, and process observation

`ops/platform/host/release.py:56-94` joins the candidate, host machine, gateway project/public host, images, and database targets, but has no profile identity. `ops/platform/compose.yaml:1,23-230` derives one Compose project from `APP_ENV` and uses a fixed ten-service topology and internal network layout. `ops/platform/host/certificates.py:23-49` fixes `api-staging.lashher.com`, `lash-her-staging`, and current staging storage roots.

For a separate host:

- Preserve the ten service names, internal origins (`course-tls`, `community-tls`), network addresses, and service JWT identities.
- Bind the new host machine ID, public host, Vercel project, database targets, images, profile ID, and profile digest in `runtime.json`, `gateway.json`, migration plans, and receipts.
- Keep the existing physical host lock path; host separation makes it independent.
- Render a profile-specific certificate plan and watchdog unit from source-owned values.
- Update active certification observers that currently require Compose label `lash-her-staging`, including `frontend_gateway_observation.py:35-41`, `p2_identity_probe_scope.py:129`, `p2_identity_negative_probe.py:202`, `p2_prior_gateway.py:110-119`, and `p2_known_ack_loss.py:528-545`.

Historical staging recovery/restore/retirement modules (`staging_recovery.py`, `staging_restore.py`, `staging_retire.py`, cold restore, and current provider retirement reducers) should remain current-profile-only. The isolated lane starts from new resources; it must not reinterpret current staging history, retire current resources, or accept current historical receipts.

### 4. Database target and role policies

All three databases require new reviewed direct targets and roles. The frontend role names are fixed at `ops/platform/frontend-role-preparation.mjs:8`; the frontend migration target/empty bootstrap checks are at `ops/platform/frontend-migration.mjs:105,238-253`.

Both APIs already support an explicitly approved empty database: `src/db/migration-lineage.ts:202-223` requires a read-only repeatable-read session, exact database/role/major, an empty non-system catalog, `allowEmptyBootstrap=true`, the complete expected pending-tag sequence, and verified TLS. Postflight disables empty bootstrap (`src/db/migration-release.ts:174-185`). This is the correct isolated-lane bootstrap primitive; it does not require copying an existing journal or terminal receipt.

The blocking API seam is the role policy. In both repositories, `src/db/operator-migration.ts:83-94,123-149` authorizes only the current `neondb`/`neondb_owner` staging layout and hardcoded staging role names. Extend its closed source policy with the target-profile ID/digest and an exact profile-specific role/owner/database policy. Do not generalize it to arbitrary names supplied by a manifest.

For the first isolated apply:

1. Independently review the provider identity and direct TLS targets.
2. Create exact migration/runtime roles using the existing least-privilege preparation policy.
3. Set `allowEmptyBootstrap=true` and `approvedPendingTags` to the exact full migration chain for each genuinely empty database.
4. Prove the non-system catalog is empty before apply.
5. Apply once under the physical migration lock, retain original receipts, then require the full journal and `allowEmptyBootstrap=false` for every later run.

No current journal, current terminal receipt, accepted historical hash, or target role/OID may be copied or relabeled as isolated evidence.

### 5. Provider and callback identities

The current source pins one provider set:

- Vercel: `ops/platform/frontend-provider-bindings.mjs:7-10`.
- Resend: `ops/platform/frontend-provider-bindings.mjs:87-98` and `src/lib/writer-admission/resend-binding-probe.ts:5,20-27`.
- Sanity: `ops/platform/frontend-provider-bindings.mjs:123-134` and `src/lib/env/application-environment.mjs:11-14`.
- Google: `ops/platform/frontend-provider-bindings.mjs:136-150` and `src/lib/writer-admission/google-binding-probe.ts:5-12,36`.
- Square sandbox: `ops/platform/frontend-provider-bindings.mjs:108-121`.
- Current webhook ingress: `ops/staging/configure-webhook-ingress.mjs:8,16-33`.
- Mux/current frontend origin: `ops/staging/providers.json:238-255`.

These are target-control identities, not generic provider capabilities. The isolated profile needs distinct reviewed records or an explicit owner decision to share a provider tenant. No provider mutation should be enabled until the corresponding real IDs exist. Qualification adapters may consume only the selected profile; current provider fencing/retirement modules must remain incapable of selecting the isolated profile.

### 6. CI and deployed certification

The owned PostgreSQL fixtures in `.github/workflows/ci.yml:72-129` are offline source/role/recovery qualifications. They remain target-neutral and do not establish an isolated live target. Add profile unit/negative tests there, but do not relabel those receipts as deployed evidence.

`platform-artifacts.yml:450-540` builds, verifies, rehearses, and attests a source/artifact candidate without deploying it. Its candidate artifact must include the profile ID/digest and exact source pins. Deployment/certification should use a separate manual job with a closed mapping to the isolated profile. A dedicated GitHub Environment may be used for variable/secret isolation, but it is optional tooling and must not introduce a mandatory Environment approval or extra approval click. The existing Dardan reviewed release action remains the approval under `docs/api-integration/release-policy.md`.

Community's deployed E2E workflow currently offers only `staging` and binds the GitHub Environment directly from that input (`.github/workflows/deployed-e2e.yml:5-21,31-41`). Replace this with a closed profile choice and source-owned target mapping. If a dedicated GitHub Environment is used for isolation, it must not add a mandatory approval gate. Course has no equivalent deployed workflow at the reviewed commit; the coordinating frontend lane should own the three-source certification dispatch.

## Real nonsecret inputs required before the isolated profile may exist

These values are currently unknown and must not be invented:

1. Vercel team decision, new project ID, project repository link, canonical alias/origin, and deployment protection policy.
2. Gateway DNS host, certificate/DNS control, Linux host machine ID, Compose project name, release/config/result roots, and watchdog identity.
3. Direct TLS database host, port, database, provider identity reference, server major, migration/runtime role names, owner name, and actual role OIDs for frontend, Course, and Community.
4. Google project ID/number, identity and calendar OAuth client IDs, allowed origins, and callback URLs.
5. Resend account/domain ID and verified sending domain.
6. Sanity project/dataset decision. Sharing the current editorial project is not isolation and requires explicit approval.
7. Mux organization/environment/webhook IDs and CORS origin.
8. Square sandbox application/location/webhook IDs if Square regression is included.
9. CI target mapping, nonsecret variables, and runtime-only secret inventory; optionally a dedicated GitHub Environment with no additional mandatory approval.

Credentials remain in their existing runtime handoff mechanisms. This plan does not authorize reading, copying, or creating them.

## Identities that should not become profile variables

- Canonical GitHub repositories and the exact three source revisions.
- Course/Community service names, JWT issuers/audiences/subjects, 300-second TTL, and 30-second skew.
- Internal Compose service names and private TLS origins.
- OpenAPI and enrollment-event schemas.
- Native cron path/schedule and source-policy hashes.
- Fault profiles, replay/ordering rules, feature controls, admission semantics, and migration lock key.

Changing these would be a contract or security change, not isolated target support.

## Shared artifacts and contracts

The public Course/Community/OpenAPI/enrollment contracts do not need a target-profile field. The profile is operator/release metadata.

The following internal schemas must be changed together and versioned if their existing strict shapes cannot accept additive fields:

- frontend release candidate, approval, runtime plan, gateway configuration, migration jobs, and terminal receipts;
- frontend admission target and native/browser/lifecycle certification plans;
- Course and Community approved target, operator migration manifest, migration release plan, lineage receipt, and terminal receipt;
- CI candidate attestation and staging-certification evidence index.

One frontend integration owner must own the profile registry, canonical hashing, candidate schema, workflow wiring, generated evidence indexes, and lockfiles. Course and Community each retain one integration owner for their target/manifest/receipt schema. Workers must not independently define profile maps or regenerate shared artifacts.

## Bounded parallel implementation plan

| Package | Earliest start | Owner boundary | Parallel placement |
|---|---|---|---|
| A. Closed profile schema, current-profile compatibility, hash and negative tests | After explicit implementation authorization | Frontend integration owner | Serial interface gate. Register current staging only. |
| B. Candidate/runtime/gateway/host profile propagation | After A interface freeze | Frontend host/release owner | Parallel with C, D, E and F. Separate-host assumption. |
| C. Vercel/app/browser/native profile consumers | After A | Frontend application/provider owner | Parallel with B, D, E and F. No live calls. |
| D. Frontend DB role/admission/migration profile support and true-empty bootstrap fixtures | After A | Frontend DB integration owner | Parallel with B, C, E and F; serializes shared migration artifacts with frontend integration owner. |
| E. Course approved target, closed role policy, migration/receipt profile binding | After shared field names freeze | Course integration owner | Parallel with D and F. Own schemas, tests, lockfile. |
| F. Community equivalent | After shared field names freeze | Community integration owner | Parallel with D and E. Own schemas, tests, lockfile. |
| G. CI candidate/profile attestation and dedicated certification dispatch | After A; final wiring after B-F | Frontend CI integration owner | Tests can start early; shared workflow edits and artifact generation are serialized. |
| H. Provider-specific isolated bindings | Only after each real ID and owner decision exists | One owner per provider, coordinated by frontend integration owner | Google, Resend, Sanity, Mux, and Square can be prepared in parallel. Live mutations remain single-operator and serialized. |
| I. Isolated deployment and P2-12/G2 evidence | B-H integrated and checks pass | Sole release operator | Read-only browser/API scenarios may run in parallel; database changes, provider mutations, native toggles, and fault injection are serialized. |

## Completion and refusal conditions

The isolated lane is implementable only when:

- the profile exists as reviewed source with real IDs and a stable digest;
- every candidate, target, plan, and receipt rejects the current staging profile/receipt when the isolated profile is selected, and vice versa;
- empty database bootstrap is proven on all three direct TLS targets, followed by full postflight journal/schema checks;
- the exact source/image/profile/host/database/Vercel/provider identities are re-read at qualification time;
- current staging historical reducers, provider retirement paths, and production targets remain unreachable from the isolated profile;
- the final evidence states whether provider tenants are dedicated or explicitly shared and does not infer isolation from source fixtures.

Until then the correct state is `OPEN: isolated target profile identifiers and live resources not approved`; current staging qualification behavior remains unchanged.
