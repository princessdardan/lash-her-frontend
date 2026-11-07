import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { frontendProviderBindingsArtifact, prepareFrontendProviderBindings, FRONTEND_VERCEL_PROJECT as PROJECT,
  FRONTEND_RELATED_PRODUCTION_PROJECT as PRODUCTION_PROJECT, FRONTEND_VERCEL_TEAM as TEAM, FRONTEND_VERCEL_REPOSITORY as REPOSITORY } from "./frontend-provider-bindings.mjs";
import { frontendCoordinationHash as hash, validateFrontendFenceObservation } from "./frontend-release-inventory.mjs";
import { frontendGoogleSnapshotSha256 } from "./frontend-google-effects.mjs";
import { frontendReleaseReceiptStore } from "./frontend-release-receipts.mjs";
import { fenceFrontendExternalProducers, runFrontendVercelWorker, observeFrontendExternalFences, observeCompatibleFrontend, readCompatibleFrontendWorkloadReceipt, readFrontendEstablishedFence } from "./frontend-release-adapters.mjs";
import * as adapterExports from "./frontend-release-adapters.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("every legacy provider continuation rejects profiled carriers before private reads or effects", async () => {
  const profile = { version: 1, id: "staging-current", sha256: "ea88751524540bfe177e089680b41d6f35b2454d73d17ef9a40b7663381225ba" };
  const changes = [
    value => { value.qualificationTargetProfile = profile; },
    value => { value.plan.qualificationTargetProfile = profile; },
    value => { value.plan.version = 2; },
    value => { value.candidate.qualificationTargetProfile = profile; },
    value => { value.candidate.version = 3; },
    ...["frontendMigration", "sourceApproval", "integration", "workload", "approval"].map(key => value => {
      value.candidate[key] = { ...value.candidate[key], qualificationTargetProfile: profile };
    }),
    value => { value.candidate.sources.frontend.qualificationTargetProfile = profile; },
    ...["bootstrapCompatibility", "restoration", "target"].map(key => value => { value.plan[key] = { qualificationTargetProfile: profile }; }),
    ...["job", "database", "migration", "bootstrapRuntimeTarget", "preapplicationSchema", "admissionObservation", "forwardRecoveryScope"]
      .map(key => value => { value[key] = { qualificationTargetProfile: profile }; }),
  ];
  const entries = Object.entries(adapterExports);
  assert.equal(entries.length, 26);
  for (const [name, entry] of entries) for (const change of changes) {
    const value = fixture();
    change(value);
    const tripwire = () => { throw new Error("PRIVATE_IO_BEFORE_POLICY_REFUSAL"); };
    Object.defineProperty(value, "directory", { get: tripwire });
    value.verifyLockedSession = tripwire;
    value.getProviderContext = tripwire;
    value.record = tripwire;
    value.databaseClient = { query: tripwire };
    const args = name === "runFrontendVercelWorker" ? ["observe-vercel", value] :
      name.includes("CrmShipping") ? ["highlevel", value] : [value, {}];
    await assert.rejects(entry(...args), { message: "QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED" }, name);
  }
  const value = fixture();
  Object.defineProperty(value, "directory", { get() { throw new Error("PRIVATE_READ_BEFORE_POLICY_REFUSAL"); } });
  await assert.rejects(readCompatibleFrontendWorkloadReceipt(value, { qualificationTargetProfile: profile }),
    { message: "QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED" });
});

function fixture(provider = "square") {
  const plan = { version: 1, environment: "staging", actionId: "adapter-owned", sourceCommit: "a".repeat(40), targetSha256: "b".repeat(64) };
  const identities = [{ kind: "deployment", identity: { provider: "vercel", teamId: TEAM, projectId: PROJECT, deploymentId: "dpl_previous" } },
    { kind: "scheduler", identity: { provider: "vercel", teamId: TEAM, projectId: PROJECT, scheduler: "native-crons" } },
    { kind: "provider", identity: { provider, accountSha256: "c".repeat(64), credentialBindingSha256: "d".repeat(64) } },
    { kind: "direct-caller", identity: { provider: "manual", accountSha256: "e".repeat(64), credentialBindingSha256: "f".repeat(64) } }];
  plan.externalSurfaces = identities.map(row => ({ kind: row.kind, identitySha256: hash(row.identity), surfaceSha256: hash({ kind: row.kind, identitySha256: hash(row.identity) }) }))
    .sort((a, b) => a.surfaceSha256.localeCompare(b.surfaceSha256));
  const input = { version: 1, environment: "staging", actionId: plan.actionId, sourceCommit: plan.sourceCommit, targetSha256: plan.targetSha256,
    teamId: TEAM, projectId: PROJECT, repositoryId: REPOSITORY, projectState: { productionDeploymentId: "dpl_previous", nativeSchedulesEnabled: false },
    deployments: [{ deploymentId: "dpl_previous", sourceCommit: "b".repeat(40), target: "production", createdAt: 10, url: "previous.vercel.app", state: "READY" }],
    surfaces: identities.map(row => ({ ...row, surfaceSha256: plan.externalSurfaces.find(surface => surface.kind === row.kind).surfaceSha256 })) };
  const artifact = frontendProviderBindingsArtifact(input, plan); plan.providerBindingsSha256 = hash(artifact);
  const candidate = { version: 2, environment: "staging", releaseId: plan.actionId, sources: { frontend: { repository: "https://github.com/princessdardan/lash-her-frontend.git",
    commit: plan.sourceCommit, requiredChecks: "passed" } }, workload: { projectId: PROJECT, environment: "production" } };
  return { plan, input, artifact, candidate };
}

test("concrete binding artifact ties every deployment and scheduler to exact reviewed surface identities", () => {
  const f = fixture(); assert.deepEqual(prepareFrontendProviderBindings(f.input, f.plan), f.artifact);
  for (const change of [i => { i.projectId = "prj_wrong"; }, i => { i.deployments.push(i.deployments[0]); },
    i => { i.projectState.productionDeploymentId = "dpl_unknown"; }, i => { i.deployments[0].state = "UNKNOWN"; },
    i => { i.deployments[0].url = "untrusted.example.com"; }, i => { i.surfaces[0].identity.deploymentId = "dpl_wrong"; },
    i => { i.surfaces[1].identity.projectId = "prj_wrong"; }, i => { i.surfaces.pop(); }, i => { i.sourceCommit = "f".repeat(40); }]) {
    const input = structuredClone(f.input); change(input); assert.throws(() => prepareFrontendProviderBindings(input, f.plan));
  }
  const input = structuredClone(f.input); input.password = "private-marker"; input.surfaces[0].identity.password = "private-marker";
  assert.equal(JSON.stringify(prepareFrontendProviderBindings(input, f.plan)).includes("private-marker"), false);
  assert.throws(() => prepareFrontendProviderBindings(f.input, { ...f.plan, providerBindingsSha256: "f".repeat(64) }));
  const retirement = structuredClone(f.input);
  retirement.deploymentRetirement = { preserveBootstrapDeployment: true, retireDeploymentIds: ["dpl_previous"], preserveDeploymentIds: [] };
  const reviewed = frontendProviderBindingsArtifact(retirement, f.plan);
  assert.deepEqual(reviewed.deploymentRetirement, retirement.deploymentRetirement);
  for (const invalid of [r => { r.preserveBootstrapDeployment = false; }, r => { r.preserveDeploymentIds.push("dpl_previous"); },
    r => { r.retireDeploymentIds = []; }, r => { r.retireDeploymentIds = ["dpl_unknown"]; }]) {
    const copy = structuredClone(retirement); invalid(copy.deploymentRetirement);
    assert.throws(() => frontendProviderBindingsArtifact(copy, f.plan));
  }
});

test("related production-project inventory includes raw null previews and refuses production-target retirement selections", () => {
  const f = fixture();
  const identity = { provider: "vercel", teamId: TEAM, projectId: PRODUCTION_PROJECT, deploymentId: "dpl_ownedpreview" };
  const identitySha256 = hash(identity), surfaceSha256 = hash({ kind: "deployment", identitySha256 });
  f.plan.externalSurfaces.push({ kind: "deployment", identitySha256, surfaceSha256 });
  f.input.surfaces.push({ kind: "deployment", identity, surfaceSha256 });
  f.input.relatedProjects = [{ projectId: PRODUCTION_PROJECT,
    deployments: [{ deploymentId: "dpl_ownedpreview", sourceCommit: "c".repeat(40), target: null, createdAt: 11, url: "owned-preview.vercel.app", state: "READY" }],
    retirePreviewDeploymentIds: ["dpl_ownedpreview"] }];
  const prepared = frontendProviderBindingsArtifact(f.input, f.plan);
  assert.equal(prepared.relatedProjects[0].deployments[0].target, "preview");
  assert.equal(prepared.surfaces.find(row => row.surfaceSha256 === surfaceSha256).identity.projectId, PRODUCTION_PROJECT);
  const changed = structuredClone(f.input); changed.relatedProjects[0].deployments[0].target = "production";
  assert.throws(() => frontendProviderBindingsArtifact(changed, f.plan));
  changed.relatedProjects[0].retirePreviewDeploymentIds = [];
  assert.equal(frontendProviderBindingsArtifact(changed, f.plan).relatedProjects[0].deployments[0].target, "production");
});

test("Resend retirement artifact binds only isolated staging domain and exact scoped key/webhook/email IDs", () => {
  const f = fixture("resend");
  f.input.resendRetirement = { domainId: "d7371c9b-b16d-41d8-b9e8-3286b58eb432", domainName: "mail.staging.lashher.com",
    retiredKeyId: "c133ba26-4f99-4450-beab-49912e586d3a", replacementKeyId: "b133ba26-4f99-4450-beab-49912e586d3b",
    expectedKeyIds: ["c133ba26-4f99-4450-beab-49912e586d3a", "b133ba26-4f99-4450-beab-49912e586d3b"],
    webhookIds: ["333dea10-e8c3-44a5-bb93-bf2d4c604811"], knownEmailIds: [] };
  const prepared = frontendProviderBindingsArtifact(f.input, f.plan);
  assert.equal(prepared.resendRetirement.expectedKeyIds[0], f.input.resendRetirement.replacementKeyId);
  for (const mutate of [r => { r.domainName = "mail.lashher.com"; }, r => { r.domainId = "../domains"; },
    r => { r.replacementKeyId = r.retiredKeyId; }, r => { r.expectedKeyIds.pop(); }, r => { r.webhookIds.push(r.webhookIds[0]); }]) {
    const changed = structuredClone(f.input); mutate(changed.resendRetirement);
    assert.throws(() => frontendProviderBindingsArtifact(changed, f.plan));
  }
});

test("historical runtime records bind original source, exact selected physical login and all selected retired credential variables", () => {
  const f = fixture("chitchats");
  f.plan.historicalLogins = { retiredLogins: [{ name: "retired_runtime", oid: "123" }] };
  const provider = f.plan.externalSurfaces.find(row => row.kind === "provider");
  f.input.historicalRuntimeBindings = f.input.surfaces.filter(row => ["deployment", "direct-caller"].includes(row.kind)).map(surface => ({
    surfaceSha256: surface.surfaceSha256, sourceCommit: surface.kind === "deployment" ? "b".repeat(40) : "c".repeat(40),
    configurationRecordSha256: "1".repeat(64), databaseRole: { name: "retired_runtime", oid: "123" },
    providerCredentials: [{ providerSurfaceSha256: provider.surfaceSha256, runtimeKey: "chitchatsRetiredToken" }],
    currentEnvEquivalent: true, privatePassword: "private-marker" }));
  assert.equal(JSON.stringify(frontendProviderBindingsArtifact(f.input, f.plan)).includes("private-marker"), false);
  for (const change of [r => { r[0].sourceCommit = "e".repeat(40); }, r => { r[0].databaseRole.oid = "124"; },
    r => { r[0].providerCredentials = []; }, r => { r[0].providerCredentials[0].runtimeKey = "arbitrarySecret"; },
    r => { r[0].configurationRecordSha256 = "0".repeat(64); }]) {
    const copy = structuredClone(f.input); change(copy.historicalRuntimeBindings);
    assert.throws(() => frontendProviderBindingsArtifact(copy, f.plan));
  }
});

test("Square retirement artifact permits only dedicated sandbox IDs and actual financial row references", () => {
  const f = fixture();
  f.input.squareRetirement = { environment: "sandbox", credentialKind: "personal-access-token", locationId: "LE2H76M5V90AM", apiVersion: "2026-05-20",
    merchantId: "ownedMerchant", applicationId: "sandbox-sq0idb-owned", webhookIds: ["wbhk_b8cf77ce0a5142b38b93715c05ede7d5"], effects: [] };
  assert.deepEqual(frontendProviderBindingsArtifact(f.input, f.plan).squareRetirement, f.input.squareRetirement);
  for (const change of [r => { r.environment = "production"; }, r => { r.credentialKind = "oauth"; }, r => { r.locationId = "production"; },
    r => { r.applicationId = "sq0idp-production"; }, r => { r.webhookIds = ["wbhk_7059795d5bdc460fb9333430fa70c0ec"]; },
    r => { r.effects = [{ recordKind: "arbitrary-table", recordId: "11111111-1111-4111-8111-111111111111", databaseRowSha256: "a".repeat(64) }]; }]) {
    const copy = structuredClone(f.input); change(copy.squareRetirement); assert.throws(() => frontendProviderBindingsArtifact(copy, f.plan));
  }
});

test("Sanity hook selection binds only dedicated staging project, exact IDs and reviewed ingress paths", () => {
  const f = fixture("sanity");
  f.input.sanityRetirement = { projectId: "7o23yrvk", dataset: "staging-2026-05-10",
    hooks: [{ hookId: "5a1KWQjkVBYLeAU3", path: "/api/revalidate", secret: "private-marker" }] };
  const normalized = frontendProviderBindingsArtifact(f.input, f.plan);
  assert.deepEqual(normalized.sanityRetirement.hooks, [{ hookId: "5a1KWQjkVBYLeAU3", path: "/api/revalidate" }]);
  assert.equal(JSON.stringify(normalized).includes("private-marker"), false);
  for (const change of [r => { r.projectId = "3auncj84"; }, r => { r.dataset = "production"; },
    r => { r.hooks[0].path = "/api/webhooks/square"; }, r => { r.hooks[0].hookId = "../production"; },
    r => { r.hooks.push(r.hooks[0]); }]) {
    const copy = structuredClone(f.input); change(copy.sanityRetirement);
    assert.throws(() => frontendProviderBindingsArtifact(copy, f.plan));
  }
});

test("Google selection binds distinct reviewed staging clients, grants and hashed calendar identities", () => {
  const f = fixture("google");
  const redisBefore = { grants: [{ grantId: "booking:google-refresh-token:production", present: false },
    { grantId: "booking:google-refresh-token", present: false }], stateKeySha256: [] };
  f.input.googleRetirement = { projectId: "lash-her-staging-20261022", projectNumber: "185770842371", sourceBindingSha256: "1".repeat(64),
    databaseSnapshotSha256: frontendGoogleSnapshotSha256({ connections: [], assignments: [], events: [] }),
    databaseBeforeSnapshot: { connections: [], assignments: [], events: [] }, redisSnapshotSha256: frontendGoogleSnapshotSha256(redisBefore),
    redisBeforeSnapshot: redisBefore, legacyCalendarSha256: null,
    clients: [{ kind: "identity", clientId: "185770842371-d3thak0b2btgb77pngj968nvhpjkqmgf.apps.googleusercontent.com" },
      { kind: "calendar", clientId: "185770842371-lg0fktlf96u88pnqjnoom83st75btv4d.apps.googleusercontent.com" }].map(row => ({ ...row,
        verificationOwnerSha256: "4".repeat(64), retiredCredentialBindingSha256: "5".repeat(64), replacementCredentialBindingSha256: "6".repeat(64), secret: "private-google-marker" })),
    grants: [], calendars: [] };
  const normalized = frontendProviderBindingsArtifact(f.input, f.plan);
  assert.equal(JSON.stringify(normalized).includes("private-google-marker"), false);
  assert.equal(normalized.googleRetirement.clients[0].kind, "calendar");
  for (const mutate of [row => { row.projectNumber = "87626194287"; }, row => { row.clients[0].clientId = row.clients[1].clientId; },
    row => { row.clients[0].replacementCredentialBindingSha256 = row.clients[0].retiredCredentialBindingSha256; },
    row => { row.databaseSnapshotSha256 = "0".repeat(64); }, row => { row.calendars.push({ calendarSha256: "7".repeat(64), grantId: "unknown" }); },
    row => { row.grants.push({ grantId: "production-token", ownerSha256: "8".repeat(64), disposition: "retire" }); }]) {
    const changed = structuredClone(f.input); mutate(changed.googleRetirement);
    assert.throws(() => frontendProviderBindingsArtifact(changed, f.plan));
  }
});

test("CRM and shipping bindings preserve only scoped nonsecret credential provenance and exact provider IDs", () => {
  for (const provider of ["highlevel", "chitchats"]) {
    const f = fixture(provider), key = `${provider}Retirement`;
    f.input[key] = { environment: "staging", sourceBindingSha256: "1".repeat(64), databaseSnapshotSha256: "2".repeat(64),
      retiredCredentialBindingSha256: "3".repeat(64), replacementCredentialBindingSha256: "4".repeat(64), privateToken: "private-marker",
      ...(provider === "chitchats" ? { credentialKind: "personal-access-token", clientId: "owned-client", expectedProviderShipmentIds: [] } :
        { credentialKind: "oauth-installation", locationId: "owned-location", companyId: "owned-company", appId: "owned-app", oauthClientId: "owned-oauth-client",
          expectedProviderContactIds: [], expectedWorkflowIds: [] }) };
    assert.equal(JSON.stringify(frontendProviderBindingsArtifact(f.input, f.plan)).includes("private-marker"), false);
    for (const change of [row => { row.environment = "production"; }, row => { row.credentialKind = "unknown-kind"; },
      row => { row.replacementCredentialBindingSha256 = row.retiredCredentialBindingSha256; }, row => { row.sourceBindingSha256 = "0".repeat(64); },
      row => { row[provider === "chitchats" ? "clientId" : "locationId"] = "../outside-scope"; }]) {
      const copy = structuredClone(f.input); change(copy[key]); assert.throws(() => frontendProviderBindingsArtifact(copy, f.plan));
    }
    if (provider === "highlevel") {
      f.input[key].locationId = "vd09FLBpPLXuHb5Tnhn4";
      assert.throws(() => frontendProviderBindingsArtifact(f.input, f.plan));
    }
  }
});

test("restoration gateway binding selects an exact existing machine/configuration/image without copying runtime input", () => {
  const f = fixture();
  f.input.gatewayObservation = { hostMachineId: "1".repeat(32), releaseId: "existing-host", candidateSha256: "2".repeat(64),
    gatewayConfigurationSha256: "3".repeat(64), runtimeConfigurationSha256: "4".repeat(64),
    gatewayImage: `ghcr.io/princessdardan/lash-her-platform-gateway@sha256:${"5".repeat(64)}` };
  const normalized = frontendProviderBindingsArtifact(f.input, f.plan).gatewayObservation; assert.deepEqual(normalized, f.input.gatewayObservation);
  const restoration = { gatewayBindingSha256: hash(normalized) };
  assert.deepEqual(frontendProviderBindingsArtifact(f.input, { ...f.plan, restoration }).gatewayObservation, normalized);
  assert.throws(() => frontendProviderBindingsArtifact(f.input, { ...f.plan, restoration: { gatewayBindingSha256: "a".repeat(64) } }));
  assert.throws(() => frontendProviderBindingsArtifact(f.input, { ...f.plan, restoration: { gatewayBindingSha256: "0".repeat(64) } }));
  for (const change of [v => { v.hostMachineId = "0".repeat(32); }, v => { v.gatewayImage = "unreviewed:latest"; },
    v => { v.gatewayConfigurationSha256 = "0".repeat(64); }, v => { v.candidateSha256 = "unknown"; }]) {
    const copy = structuredClone(f.input); change(copy.gatewayObservation); assert.throws(() => frontendProviderBindingsArtifact(copy, f.plan));
  }
});

test("missing runtime context refuses before any provider process and records missing capabilities", async () => {
  const f = fixture(), records = [], context = { plan: f.plan, record: (name, value) => records.push({ name, value }), verifyLockedSession: () => {} };
  await assert.rejects(fenceFrontendExternalProducers(context), /FRONTEND_PROVIDER_INGRESS_CONTROL_FAILED_REVIEW_REQUIRED/u);
  assert.equal(records.length, 1); assert.equal(records[0].value.historicalWritersFenced, false);
  assert.equal(records[0].value.activeExecutions, null); assert.equal(records[0].value.uncertainEffects, null);
  await assert.rejects(runFrontendVercelWorker("observe-vercel", context), /FRONTEND_VERCEL_ADAPTER_FAILED_REVIEW_REQUIRED/u);
  await assert.rejects(observeFrontendExternalFences(context), /FRONTEND_PROVIDER_RUNTIME_CONTEXT_REFUSED/u);
  await assert.rejects(observeFrontendExternalFences({ ...context, checkpoint: "recovery" }), /FRONTEND_PROVIDER_RUNTIME_CONTEXT_REFUSED/u);
  await assert.rejects(observeCompatibleFrontend({ ...context, checkpoint: "recovery" }), /FRONTEND_VERCEL_ADAPTER_FAILED_REVIEW_REQUIRED/u);
});

test("private runtime supplier errors are sanitized and do not expose credentials", async () => {
  const f = fixture(), records = [], context = { plan: f.plan, verifyLockedSession: () => {}, record: (_name, value) => records.push(value),
    getProviderContext: () => { throw new Error("private-runtime-marker"); } };
  await assert.rejects(runFrontendVercelWorker("observe-vercel", context), error => !error.message.includes("private-runtime-marker"));
  await assert.rejects(fenceFrontendExternalProducers(context), error => !error.message.includes("private-runtime-marker"));
  assert.equal(JSON.stringify(records).includes("private-runtime-marker"), false);
});

test("unknown invocation/callback counts are retainable only in deliberate read-only recovery", async () => {
  const f = fixture(), nonce = "1".repeat(64), surfaces = f.plan.externalSurfaces.map(surface => {
    const observation = Buffer.from('{"projectPaginationComplete":true,"databaseBindingsVerified":false}');
    const reconciliation = Buffer.from('{"status":"UNAVAILABLE"}');
    const evidence = Buffer.from(JSON.stringify({ version: 1, nonce, actionId: f.plan.actionId, sourceCommit: f.plan.sourceCommit, targetSha256: f.plan.targetSha256,
      ...surface, state: "unfenced", activeExecutions: null, uncertainEffects: null, observationSha256: hash(observation), reconciliationSha256: hash(reconciliation) }));
    return { surfaceSha256: surface.surfaceSha256, evidence, evidenceSha256: hash(evidence), observation, reconciliation };
  });
  const observed = { version: 1, nonce, actionId: f.plan.actionId, sourceCommit: f.plan.sourceCommit, targetSha256: f.plan.targetSha256, inventorySha256: hash(f.plan), surfaces };
  await assert.rejects(validateFrontendFenceObservation(f.plan, nonce, observed, () => {}));
  const actual = await validateFrontendFenceObservation(f.plan, nonce, observed, () => {}, { requireFenced: false });
  assert.equal(actual.surfaces.every(row => row.activeExecutions === null && row.uncertainEffects === null), true);
});

test("restoration rereads exact retained strict history instead of accepting a summary boolean or changed evidence", async () => {
  const f = fixture(), nonce = "1".repeat(64), directory = realpathSync(mkdtempSync(join(tmpdir(), "frontend-established-fence-")));
  try {
    const store = frontendReleaseReceiptStore(directory), inventorySha256 = hash(f.plan);
    const surfaces = f.plan.externalSurfaces.map(surface => {
      const observation = Buffer.from(JSON.stringify({ status: "OWNED_OBSERVATION", surfaceSha256: surface.surfaceSha256 }));
      const reconciliation = Buffer.from(JSON.stringify({ status: "OWNED_RECONCILIATION", rawInvocationCount: null }));
      const state = surface.kind === "provider" ? "credentials-retired-and-effects-reconciled" : surface.kind === "scheduler" ?
        "disabled-and-running-executions-reconciled" : "retired-and-effects-reconciled";
      const evidence = Buffer.from(JSON.stringify({ version: 1, nonce, actionId: f.plan.actionId, sourceCommit: f.plan.sourceCommit, targetSha256: f.plan.targetSha256,
        ...surface, state, activeExecutions: 0, uncertainEffects: 0, observationSha256: hash(observation), reconciliationSha256: hash(reconciliation) }));
      return { surfaceSha256: surface.surfaceSha256, evidence, evidenceSha256: hash(evidence), observation, reconciliation };
    });
    const proof = await validateFrontendFenceObservation(f.plan, nonce, { version: 1, nonce, actionId: f.plan.actionId, sourceCommit: f.plan.sourceCommit,
      targetSha256: f.plan.targetSha256, inventorySha256, surfaces }, store.retain);
    await store.record("external-fences-after-promotion.json", proof);
    const observed = await readFrontendEstablishedFence({ plan: f.plan, inventorySha256, directory });
    assert.equal(observed.strictEvidenceSha256.length, f.plan.externalSurfaces.length);
    const changed = { ...JSON.parse(surfaces[0].evidence.toString("utf8")), fenced: true };
    writeFileSync(join(directory, `${nonce}-${f.plan.externalSurfaces[0].surfaceSha256}.json`), JSON.stringify(changed));
    await assert.rejects(readFrontendEstablishedFence({ plan: f.plan, inventorySha256, directory }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

async function protocolFixture(code, task) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "frontend-provider-protocol-"))), app = join(directory, "app");
  try {
    mkdirSync(join(app, "ops/platform/host"), { recursive: true }); mkdirSync(join(app, "src/lib/private-db"), { recursive: true });
    mkdirSync(join(app, "scripts"), { recursive: true });
    for (const name of ["api-contract-tools.mjs", "api-contract-compatibility-review.mjs"])
      copyFileSync(join(root, "scripts", name), join(app, "scripts", name));
    const modules = ["p2-recovery-current-probe", "frontend-provider-effect-scopes", "frontend-historical-source-observer", "frontend-historical-source", "p2-certification-profile", "frontend-release-restoration", "frontend-admission", "frontend-square-effects", "frontend-google-effects", "frontend-crm-shipping-effects", "frontend-historical-capabilities", "frontend-provider-fence-join", "frontend-release-adapters", "frontend-provider-bindings", "frontend-release-inventory", "frontend-release-receipts", "frontend-admission-bootstrap", "frontend-historical-logins", "frontend-bootstrap-compatibility",
      "frontend-migration", "frontend-schema", "source-checkout", "source-policy", "release-inputs", "release", "qualification-target-profile"];
    for (const name of modules) copyFileSync(join(root, "ops/platform", `${name}.mjs`), join(app, "ops/platform", `${name}.mjs`));
    copyFileSync(join(root, "ops/platform/qualification-target-profiles.json"), join(app, "ops/platform/qualification-target-profiles.json"));
    copyFileSync(join(root, "src/lib/private-db/migration-lineage.ts"), join(app, "src/lib/private-db/migration-lineage.ts"));
    writeFileSync(join(app, "package.json"), '{"type":"module"}\n');
    symlinkSync(join(root, "node_modules"), join(app, "node_modules"), "dir");
    writeFileSync(join(app, "ops/platform/host/frontend_release_adapters.py"), code);
    const receipts = join(directory, "receipts"); mkdirSync(receipts, { mode: 0o700 });
    const imported = await import(pathToFileURL(join(app, "ops/platform/frontend-release-adapters.mjs")).href);
    const f = fixture(); let verified = 0;
    const context = { ...f, directory: receipts, verifyLockedSession: async () => { verified++; },
      getProviderContext: async () => ({ bindings: f.artifact, vercelToken: "owned-protocol-private-marker" }) };
    await task(imported, context, () => verified);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("private Python protocol checkpoints actual parent liveness and returns only sanitized frames", async () => {
  await protocolFixture(`import json,sys
value=json.loads(sys.stdin.readline())
print(json.dumps({'type':'checkpoint','id':1}),flush=True)
assert json.loads(sys.stdin.readline())=={'type':'continue','id':1}
assert value['vercelToken']=='owned-protocol-private-marker'
print(json.dumps({'type':'result','value':{'status':'OWNED_PROTOCOL_PASS'}}),flush=True)
`, async (adapter, context, count) => {
    const result = await adapter.runFrontendVercelWorker("observe-vercel", context);
    assert.equal(result.status, "OWNED_PROTOCOL_PASS"); assert.equal(count() >= 4, true);
    assert.equal(JSON.stringify(result).includes("owned-protocol-private-marker"), false);
  });
});

test("private JSON cannot select a forward recovery attempt or authorize a shared mutation", async () => {
  await protocolFixture("import json,sys,pathlib\nvalue=json.loads(sys.stdin.buffer.readline())\npathlib.Path(value['directory'],'untrusted-worker-ran.json').write_text('{}')\nraise RuntimeError('UNTRUSTED_FORWARD_SCOPE_STARTED_WORKER')\n", async (adapter, context) => {
    context.candidate.contractPhase = "p2"; context.candidate.phase2ContractManifestSha256 = `sha256:${"1".repeat(64)}`;
    const original = join(dirname(context.directory), "original"); mkdirSync(original, { mode: 0o700 });
    context.originalDirectory = original; context.databaseClient = {}; context.recoveryActionId = "reviewed-forward";
    context.inventorySha256 = "2".repeat(64);
    context.bootstrapRuntimeTarget = { environment: "staging", targetSha256: context.plan.targetSha256, user: "runtime" };
    context.forwardRecoveryScope = { version: 1, mode: "reviewed-new-build", originalDirectory: original, directory: context.directory,
      recoveryActionId: context.recoveryActionId, originalReleaseId: context.plan.actionId, candidateSha256: "3".repeat(64),
      sourceCommit: context.plan.sourceCommit, targetSha256: context.plan.targetSha256, inventorySha256: context.inventorySha256,
      configurationSha256: "4".repeat(64), originalReceiptSha256: { "frontend-release-started.json": "5".repeat(64) } };
    for (const operation of ["observe-vercel", "observe-compatible", "deploy-compatible", "retire-deployments"]) {
      await assert.rejects(adapter.runFrontendVercelWorker(operation, context), /FRONTEND_VERCEL_ADAPTER_FAILED_REVIEW_REQUIRED/u);
    }
    await assert.rejects(adapter.readCompatibleFrontendWorkloadReceipt(context, { workloadReceiptSha256: "6".repeat(64) }));
    assert.equal(existsSync(join(context.directory, "untrusted-worker-ran.json")), false);
  });
});

test("recovery workload reader keeps original exact bytes unless the live source selects a new attempt", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "frontend-original-workload-")));
  try {
    const originalDirectory = join(directory, "original"), recoveryDirectory = join(directory, "recovery");
    for (const parent of [originalDirectory, recoveryDirectory]) {
      mkdirSync(parent, { mode: 0o700 }); mkdirSync(join(parent, "vercel"), { mode: 0o700 });
    }
    const original = Buffer.from('{"status":"FRONTEND_VERIFIED","deploymentId":"dpl_original"}\n');
    const unrelated = Buffer.from('{"status":"FRONTEND_VERIFIED","deploymentId":"dpl_unrelated"}\n');
    writeFileSync(join(originalDirectory, "vercel/frontend-workload-outcome.json"), original, { mode: 0o600 });
    writeFileSync(join(recoveryDirectory, "vercel/frontend-workload-outcome.json"), unrelated, { mode: 0o600 });
    const context = { originalDirectory, directory: recoveryDirectory };
    assert.deepEqual(await readCompatibleFrontendWorkloadReceipt(context, { workloadReceiptSha256: hash(original) }), original);
    await assert.rejects(readCompatibleFrontendWorkloadReceipt(context, { workloadReceiptSha256: hash(unrelated) }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("provider worker refusal or lost parent checkpoint cannot pass through private stderr/error payloads", async () => {
  await protocolFixture(`import json,sys
value=json.loads(sys.stdin.readline())
print(json.dumps({'type':'error','detail':value['vercelToken']}),flush=True)
sys.exit(1)
`, async (adapter, context) => {
    await assert.rejects(adapter.runFrontendVercelWorker("observe-vercel", context), error => !error.message.includes("owned-protocol-private-marker"));
  });
  await protocolFixture(`import json,sys
json.loads(sys.stdin.readline())
print(json.dumps({'type':'checkpoint','id':1}),flush=True)
assert sys.stdin.readline()==''
`, async (adapter, context) => {
    let calls = 0; context.verifyLockedSession = async () => { if (++calls === 3) throw new Error("private-lock-marker"); };
    await assert.rejects(adapter.runFrontendVercelWorker("observe-vercel", context), /FRONTEND_VERCEL_ADAPTER_FAILED_REVIEW_REQUIRED/u);
  });
});

test("the same action cannot substitute an arbitrary denied credential after preflight", async () => {
  await protocolFixture(`import json,sys
json.loads(sys.stdin.readline())
print(json.dumps({'type':'result','value':{'status':'OWNED_PROTOCOL_PASS'}}),flush=True)
`, async (adapter, context) => {
    const supplier = context.getProviderContext;
    let retired = "original-owned-retired-token";
    context.getProviderContext = async () => ({ ...await supplier(), squareRetiredToken: retired });
    await adapter.runFrontendVercelWorker("observe-vercel", context);
    retired = "arbitrary-invalid-substitute";
    await assert.rejects(adapter.runFrontendVercelWorker("observe-vercel", context), error =>
      error.message === "FRONTEND_VERCEL_ADAPTER_FAILED_REVIEW_REQUIRED");
  });
});
