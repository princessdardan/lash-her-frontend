# Concrete staging Vercel release adapter

`ops/platform/frontend-release-adapters.mjs` now supplies the fixed source-pinned adapter required by the [pending SQL coordination component](frontend-release-coordination-component.md). The Python child composes existing `host/vercel.py` and `host/frontend_probe.py`; it does not introduce another service, credential store, signer or independently authorized migration executor.

The external fence requires complete source-bound historical capability, SQL, admission, ingress and settled-effect observations. Configured-provider gaps remain explicit in the [live prerequisite register](p2-historical-provider-live-gates.md); metadata and credential denial cannot supply missing effect history. No live deployment, schedule, provider access or credentials were changed to implement or test this component.

## Implemented components

| Operation | Concrete implementation and limit |
| --- | --- |
| Admission bootstrap frontend | Before application SQL, validates the separate locked preapplication schema receipt; sets all ten integration/auth/lifecycle controls literal false and exact enforced admission configuration using the privately supplied runtime URL. Uses a separate `vercel-bootstrap` intent/build/probe/promotion receipt tree. A real protected `admission-bootstrap` HTTP mode must match challenge, source, target, producer, epoch, closed controls and public catalog hash. The locked operator independently verifies the journal prefix; runtime receives no `drizzle` privileges. |
| Staging observation | Calls the authenticated fixed-team/project API, enumerates every deployment page twice, checks stable results/project state, strips provider environment/private metadata and compares against the reviewed concrete inventory. Reports project scope only; database/provider bindings remain false and running/uncertain counts remain unknown (`null`). |
| Native scheduler suspension | Reuses `vercel.disable_schedules`, retaining original intent/outcome and provider readback. Unknown running/deferred effects stay unknown. No scheduler enable/restore path exists. Exposed as `suspendFrontendVercelSchedules` for use only by a subsequently qualified parent fence. |
| Historical staging ingress retirement | `retireFrontendVercelDeployments` uses exact reviewed IDs, actual source/project checks and DELETE acknowledgements plus double inventory absence. It requires and preserves the real admission-compatible bootstrap build; partial/lost acknowledgements never retry or assert provider effect drain. [Scope and next provider packages](frontend-historical-provider-fencing.md). |
| Pending-SQL source pins | Validates the actual durable database receipt against the in-process verified receipt, exact source/action and direct-target digest. Requires `apply-forward`, schema/runtime-grant verification and the existing two staging source-pin keys, with readback. The current-only initial-staging binder remains unchanged. |
| Compatible frontend | Reuses expiring probe preparation, exact-source Production-target staging without automatic domain assignment, real protected HTTP frontend-to-gateway workload verification, and observed promotion of that retained deployment. Keeps native scheduling/admission closed. Missing receipt, wrong target, source-pin drift, lock loss, failed/ambiguous build or promotion stops without retry/rollback. |
| Provider recovery observation | Reads actual current deployment/source and selected build/alias/workload receipt state. An acknowledged failed build enters known terminal inventory only through matching original intent, accepted-ID and failed-outcome receipts plus fresh `ERROR`/`CANCELED` readback. It never becomes a staged/current identity. A lost create response retains its unknown deployment identity and unreviewed inventory extras. Historical/provider reads consume original receipts; a source-branded forward scope can select a separately verified new compatible attempt. Shared recovery operations remain read-only. |

The official [deployment listing API](https://vercel.com/docs/rest-api/deployments/list-deployments) provides pagination metadata. The [promotion guide](https://vercel.com/docs/deployments/promoting-a-deployment) distinguishes a staged Production build from preview promotion, which may rebuild. These components retain the repository's already implemented staged Production workflow.

## Reviewed binding artifact

`frontendProviderBindingsArtifact(input, plan)` creates a normalized nonsecret artifact; `prepareFrontendProviderBindings` requires its hash to equal `plan.providerBindingsSha256`. It contains:

- `version: 1`, `environment: "staging"`, exact `actionId`, `sourceCommit` and `targetSha256`.
- Fixed `teamId`, staging `projectId` and GitHub `repositoryId`; `projectState: {productionDeploymentId, nativeSchedulesEnabled}`.
- `gatewayHost`, bound to the reviewed gateway target. Metadata-only artifacts may use `null`; deployment refuses until it is a reviewed hostname matching the runtime value.
- Every deployment as `{deploymentId, sourceCommit, target, createdAt, url, state}`, sorted by deployment ID. Unavailable source/URL remains `null`; preview targets normalize to `"preview"`.
- One concrete surface per deployment, exactly one native scheduler surface, and every reviewed provider/direct-caller surface. Surface IDs and identity hashes must match `plan.externalSurfaces`; duplicate, omitted, changed or unknown identities refuse.

Surface identities use these exact shapes:

| Kind | Identity |
| --- | --- |
| `deployment` | `{provider: "vercel", teamId, projectId, deploymentId}` |
| `scheduler` | `{provider: "vercel", teamId, projectId, scheduler: "native-crons"}` |
| `provider` / `direct-caller` | `{provider: lowerCaseVendor, accountSha256, credentialBindingSha256}` |

Those account/credential digests identify reviewed scope; they do not establish that a credential was retired. The current project-only metadata capture must not be represented as verified database/provider bindings. All pages must be observed; the currently retained 25-record project snapshot does not establish exhaustive account/preview/provider scope or callback drain.

After a compatible build, observation permits only the deployment created and independently source-verified by this action, its separate bootstrap, and any exact compatible attempt selected by the recovery source. A terminal original sibling must remain absent from the current target. An unrelated extra deployment or project change remains drift; no deployment-ID allowlist supplied through private JSON can change that result.

## Private runtime and lock protocol

The parent optionally supplies `getProviderContext({actionId, sourceCommit, targetSha256})`, returning `{bindings, vercelToken, privateConfigurationDirectory, gatewayHost}` through the existing authenticated runtime-resolution path. Bootstrap additionally requires private `frontendRuntimeDatabaseUrl`, matching the selected direct database/runtime-role/TLS target; it supplies both operational/admission URL settings and is never returned or recorded. The token is consumed privately; the adapter does not fetch secret values, read CLI authentication stores, accept a token argument or load ambient dotenv/credential fallbacks. The private probe directory must be outside both Git and the common receipt tree.

The fixed child receives bounded private JSON over stdin. No token is placed in arguments, environment, output or common receipts. Before and after every actual Vercel/probe request, the child asks the Node parent for a fresh checkpoint. The parent invokes its actual environment/physical-database lock verifier before acknowledging; JSON approval flags cannot supply that verifier. A failed checkpoint, lease abort, unexpected frame, bounded-output failure or worker deadline ends the child and leaves original partial/uncertain outcomes for review. It never retries a provider mutation.

The compatible observer receives the parent's actual closed-ledger observation after SQL and after deployment; provider metadata does not invent admission state. Successful promotion observation checks the actual alias job against the original promotion intent and independently retained workload receipt. All common capability/fence results remain non-authorizing.

The initial admission build has a separate source-pin receipt kind, `verified-preapplication-schema-only`; it cannot stand in for the later `DATABASE_VERIFIED` receipt. The 300-second drain budget starts after this build/independent verification and never turns elapsed time into a drain result. A lost bootstrap promotion response preserves unknown state and closed controls. Read-only recovery includes the original bootstrap provider state even if application SQL and the final build never started.

Forward recovery uses an opaque `forwardRecoveryScope` issued by the source-owned live recovery session. The shared Node adapter obtains its projection through `readP2RecoveryForwardScope(scope, context)`; the Python child independently calls the fixed recovery module's `require_forward_scope(context, client, verify)` to validate the immutable original receipts, exclusive new action chain and actual deployment identity. The projection binds original release, new recovery action, raw candidate hash, source, physical target, inventory, configuration and both private receipt directories. It contains no caller-selected deployment IDs. Only the compatible observer and workload-receipt reader select the new `vercel` tree; original historical, provider and bootstrap receipts remain authoritative and unchanged. The workload-receipt reader is asynchronous because it verifies the live source brand before selecting a directory.

The recovery controller owns any deliberate new build and promotion. Supplying the scope does not authorize shared deployment, retirement, SQL, role, login or provider replay operations. The shared inventory retains both the original terminal sibling and the exact source-verified new READY deployment; unknown siblings remain unresolved. Post-restoration GET observations retain the source/receipt binding while admission may be deliberately open.

## Isolated verification and remaining work

Node tests cover complete concrete identities/hash binding, missing/private runtime failures including recovery, no secret-bearing error propagation, per-request private protocol checks and unknown-count refusal for SQL. Python tests use owned HTTPS provider and workload servers with the real existing Vercel client, source-pin handling, probe HTTP, staging and promotion functions. They cover actual scheduler PATCH/readback, complete pagination/drift, durable receipt/source/target refusal, source-pin readback failure, parent lock loss after a created build, failed builds, and lost build/promotion responses followed by read-only observation with unchanged receipts/no replay.

The owned provider models are synthetic component evidence. Actual vendor credential/callback controls, complete deployment/provider/database inventory, host integration, affected live qualification and deliberate producer restoration still need implementation/evidence before P2-00 can complete. This component adds no approval expiry or additional review ceremony; live actions remain part of Dardan's exact reviewed single-operator release action.
