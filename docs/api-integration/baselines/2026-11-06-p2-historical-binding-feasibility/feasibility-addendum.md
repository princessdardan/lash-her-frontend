# Finite Vercel historical-binding feasibility check

November 6, 2026. Read-only addendum to the [decision memo](../../decisions/2026-11-06-original-frontend-config-unavailable.md). The user's statement that no original frontend configuration archive exists remains final.

## Result

**No supported path to a deployment-specific original SQL/provider binding, credential-version association or sealed configuration export/attestation was established by this finite check. Stop this discovery lane here.** This does not claim that Vercel has no internal historical data or that its support could never recover anything. No support message was sent, and no additional access, export or environment-value retrieval is requested.

There is a real deployment configuration snapshot in the public API schema, but its documented content concerns function/build resources and Secure Compute settings. It must not be mistaken for the missing original application environment/binding record.

## Exact account observations

Exactly two connected `get_deployment` metadata calls used `withGitRepoInfo=true` and the existing recorded team `team_2Hrn5eMZyZxfAWdmYvyKi9t3`. Both returned successfully. Only field names, reference IDs and counts were projected; raw owner responses were neither printed nor persisted.

| Requested deployment | Returned project reference | Source reference | Configuration/binding result |
| --- | --- | --- | --- |
| C07 `dpl_Bqc171V1RouKNkjcrnVtWB1imwKH` | `prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM` | `meta.githubCommitSha=b99d4f346696f897fa6a6729dfcc52d6503fe8d6`; five metadata field names | Normalized deployment has 16 top-level fields; no `env`, `build`, `config`, configuration revision, original SQL/provider principal, sealed export or attestation reference exposed |
| Unknown CLI `dpl_5JDDu6BaZcM4sg9wip65MKCwmhuL` | `prj_wvBLVsXzC1XMZ11hSIfBi2bHXsyy` | Empty `meta` object; no authoritative source SHA exposed | Normalized deployment has 17 top-level fields, including `source`; no original binding/version/export/attestation reference exposed |

Each response has one alias entry and one region entry; neither value was retained. Identity/project/source references above match the selected existing scope. The connector normalizes the owner-capable API response. Its omission of fields is **not** evidence that those fields do not exist in Vercel's full internal/raw record. This check did not repeat the earlier raw CLI owner/catalog collection or attempt to bypass that limitation.

The exact sanitized projection is [owner-metadata-projection.json](owner-metadata-projection.json).

## Official schema and documented capability

The public [Vercel OpenAPI](https://openapi.vercel.sh/) was retrieved without authentication. It is OpenAPI 3.0.3, 12,255,866 bytes, SHA256 `60d727cb620a7b778318944a5ea12b619efa7ff35b3e0c47e94bdce9dfcc0b87`, containing 349 paths. The full public schema is retained privately for reproducibility; it contains no retrieved account response.

- `GET /v13/deployments/{idOrUrl}` selects by deployment ID/URL, with optional Git information and team scope. The owner response variant documents `env` and `build.env` as string arrays, not original key/value records or a credential-version map. Earlier retained actual key-catalog evidence remains useful within its recorded scope. [Deployment endpoint](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url).
- The optional owner `config` object is explicitly described as a creation-time snapshot. Its eight fields are `functionMemoryType`, `functionTimeout`, `functionType`, `isUsingActiveCPU`, `resourceConfig`, `secureComputeFallbackRegion`, `secureComputePrimaryRegion` and numeric `version`. `resourceConfig` covers build-machine/queue/concurrency settings. The numeric field is not documented as an environment-variable revision, export handle, SQL binding or provider principal association. The description mentions a UI `/deployments/:id/config` route, but that route is not a published OpenAPI operation; no guessed/internal request was attempted.
- `connectConfigurationId`/`passiveConnectConfigurationId` provide configuration identifiers; the latter is described as a Secure Compute network. Neither documents the original SQL/provider credential-version association sought here. `services[].env` documents service-reference wiring. `builds[].config` is open-ended; it supplies no documented binding-attestation contract. None of these schema shapes authorizes interpreting arbitrary opaque data as an original environment snapshot.
- The documented project-environment operation is `GET /v10/projects/{idOrName}/env`, with branch/custom-environment filters; it has no deployment-ID or historical revision selector. Individual environment-ID reads are documented as decrypted-value retrieval. They were **not called**. Vercel states that environment changes affect later deployments, while earlier deployments retain their prior environment. Current project state therefore cannot substitute for the historical binding. [Project environment endpoint](https://vercel.com/docs/rest-api/projects/retrieve-the-environment-variables-of-a-project-by-id-or-name); [environment semantics](https://vercel.com/docs/environment-variables).
- A bounded review of deployment/environment and historical/snapshot/export/attestation-related operations found no documented sealed historical application-environment export or deployment credential-version attestation. Actual versioned backup/history operations concern other products, including Global Config, routing, firewall and Sandbox snapshots. They cannot be relabeled as frontend deployment configuration evidence. The documentation-index query likewise identified current environment management and value-free environment-change webhooks, not the required original binding procedure.

The exact field/schema projection and 59 related operation-index entries are in [schema-inspection.json](schema-inspection.json). This is a bounded capability finding from the retrieved schema and documentation, not proof of every private platform capability.

## Consequence and stop boundary

The two metadata observations supply no new original runtime/provider/SQL binding. The unknown CLI identity remains unknown. No accepted-request lifetime, outstanding-effect completion, SQL denial, old-session termination or historical fence was observed; this check closes none of those requirements.

Existing-scope P2-00 remains unresolved; accepted G1 C07 remains unchanged. The isolated-environment alternative in the original memo remains a design choice requiring an explicit owner target/applicability decision and affected requalification. This finding authorizes no provisioning, source gate change, deployment, provider control, deletion, key action or production operation.

No environment-value/decrypt request, source file-content read, project-current configuration read, secret retrieval, root.env access, support message, value-bearing export, application request, provider mutation, authentication change or failed CLI/file-tree retry occurred. All repository/Git state was left untouched by this task.
