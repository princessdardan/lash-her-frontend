# Read-only original deployment key-name catalogs

Original deployment **key names** are partly reconstructable through Vercel's owner deployment response. C07 returned 228 runtime names and 228 build names, with a 228-name union. This recovers names, not original values, provider credentials, full historical configuration provenance, capability closures or a verified fence.

This adds new evidence to the earlier [local handoff reconciliation](../2026-11-06-existing-handoff-reconciliation/README.md). That earlier check correctly found no archived frontend configuration in its inspected local material, and the connector normalized away these owner-only fields. The supported raw owner GET exposes them. Accepted C07 and host/credential handoff evidence remains accepted within its original scope.

## Actual read-only collection

The root agent first verified isolated official Vercel CLI 50.5.1, exact staging project/team and the owner response. This worker independently verified the isolated version/API help, then used the existing cached CLI authentication with `npm exec --yes --ignore-scripts --package=vercel@50.5.1 -- vercel api <fixed path> -X GET`. No global install, login, token lookup, credential-store fetch, FIFO/dotenv read, debug/verbose logging, deployment or provider control ran. Raw stdout/stderr was captured only in operator-private mode-0600 files beneath a mode-0700 temporary receipt directory; permission checks found zero violations.

The official OpenAPI supplied to this task identifies owner `getDeployment` response `env` and `build.env` as arrays of strings, and documents `GET /v7/deployments` with project/team/limit/until pagination. Root verified the installed CLI's `GET /v9/projects` repository-URL query contract. The collection used:

1. `GET /v9/projects` with the exact frontend repository URL, fixed team and limit 100. Complete pagination found exactly the two known matching projects. No third or unclassifiable matching project was silently authorized; unrelated names/configuration were not emitted.
2. `GET /v7/deployments` for each fixed project, with team/limit 100 and cursor support, no state or target filter. Each list completed in one page.
3. Owner `GET /v13/deployments/<actual ID>?teamId=<fixed team>` for all 81 retained IDs, including production-target rows. These were metadata reads only.
4. Final complete project/deployment-list readbacks. ID/source/creation scope remained unchanged during collection. Offline reconciliation matched every ID/source/creation against the earlier retained inventory; no missing prior ID or conflict was found.

There were 87 explicit API GET invocations: two project-discovery pages, four deployment-list pages and 81 owner-deployment GETs. The final readback bounds these observations in time; it is not a perpetual global inventory or absence proof.

| Project scope | Retained rows | Source-bound catalogs | UNKNOWN |
| --- | ---: | ---: | ---: |
| Selected staging project | 25 | 25 | 0 |
| Other known repository-linked project | 56 | 51 | 5 |
| Total | 81 | 76 | 5 |

All five UNKNOWN rows have a production target and omit any authoritative Git SHA in both the fresh list and owner response. The key arrays exist, but the normalizer cannot bind them to an exact source. They remain UNKNOWN; no empty catalog, source inapplicability or safe mutation follows. Production-target reads do not authorize production controls or historical retirement.

The first collection runner looked for `id`/`uid` in the older sanitized inventory, which uses `deploymentId`. This preparation mistake affected its initial prior-count display. A separate offline reconciliation corrected that field mapping and verified that the complete fresh sets and actual owner GETs covered all 81 prior IDs with unchanged source/creation. No extra scope, missing ID, hidden retry or absent-catalog inference resulted. Original private collection/readback records remain retained.

## Source-owned normalizer and evidence format

Implementation commit `1b1b3378` adds only `ops/platform/frontend-deployment-key-catalog.mjs` and its test file. The pure `normalizeFrontendDeploymentKeyCatalog(expected, raw)` requires a closed scope containing version, fixed team/project, immutable deployment ID, exact source, fresh-row `createdAt` and observation time. Every present authoritative Git SHA must agree. Contradictory repository/owner/project/creation identities refuse. The two known projects are a closed allowlist; another discovered project would remain outside scope.

Both owner key arrays are mandatory. Each name must match `[A-Za-z_][A-Za-z0-9_]{0,191}`; lowercase is valid. Assignments, objects, duplicates, missing/redacted arrays, invalid names and oversized catalogs refuse. The normalizer keeps separate sorted `runtimeKeyCatalog` and `buildKeyCatalog`, plus a conservative sorted union `keyCatalog`. It copies no creator details, project settings, URLs, raw provider body or environment value. Its nonsecret provenance names the fixed GET resource and exact identity/time/source fields. Digests cover only sorted key-name arrays or canonical nonsecret provenance, never credential values or raw responses.

`observations.json` retains the 76 normalized observations and five explicit UNKNOWN records. For compactness, key arrays are replaced with references to the 31 exact sorted sets in `key-name-sets.json`; these contain 7,255 name entries across unique sets. Reconstruct each full observation by inserting the referenced arrays into `catalogObservation`. All 76 reconstructed objects were verified equal to the private normalized output, with canonical provenance digests checked. Canonical re-normalization used existing private responses only and performed no additional provider request.

`unit.log` records eight passing tests covering identity/source mismatches, both allowed projects, production metadata, missing owner arrays, false empty inference, duplicate/value/assignment/Unicode/whitespace rejection, bounded names and output immutability/redaction. Focused lint passes. Actual owner responses were normalized for all 76 source-bound records. No auth/schema error was converted into an absent catalog.

## Remaining scope

Every observation retains `catalogOnly: true`, `originalValuesRecovered: false`, `configuredCapabilitiesVerified: false`, `noCapabilityClosureProduced: true`, `sourceAdmissionFenceVerified: false` and `wholeReleaseAccepted: false`. Hashes bind these nonsecret records; they are not a standalone authenticated provider/SQL proof or release certificate.

The existing original-configuration reducer expects values for all catalog keys. That interface must not cause collection of unrelated platform/system values, ephemeral OIDC material or internal encryption secrets. Source-aware selection/partial-value integration is a separate root-owned decision. Source-relevant original values, actual provider/account/store bindings, original provenance and required effect/lifetime observations remain unknown where not independently supplied. The pending archive-location question concerns those source-relevant original bindings/provenance; this collection requests no duplicate credentials or SSH handoff.

No application code, shared adapter, provider setting, schedule, admission, SQL, cloud resource or host state was changed. The earlier local-runtime 15/17 byte match remains a private equality observation, not an exact C07 snapshot or frontend configuration proof.
