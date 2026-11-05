import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { frontendProviderBindingsArtifact, frontendProviderMissingCapabilities, prepareFrontendProviderBindings, FRONTEND_VERCEL_PROJECT as PROJECT,
  FRONTEND_VERCEL_TEAM as TEAM, FRONTEND_VERCEL_REPOSITORY as REPOSITORY } from "./frontend-provider-bindings.mjs";
import { frontendCoordinationHash as hash, validateFrontendFenceObservation } from "./frontend-release-inventory.mjs";
import { fenceFrontendExternalProducers, runFrontendVercelWorker, observeFrontendExternalFences, observeCompatibleFrontend } from "./frontend-release-adapters.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
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

test("restoration gateway binding selects an exact existing machine/configuration/image without copying runtime input", () => {
  const f = fixture();
  f.input.gatewayObservation = { hostMachineId: "1".repeat(32), releaseId: "existing-host", candidateSha256: "2".repeat(64),
    gatewayConfigurationSha256: "3".repeat(64), runtimeConfigurationSha256: "4".repeat(64),
    gatewayImage: `ghcr.io/princessdardan/lash-her-platform-gateway@sha256:${"5".repeat(64)}` };
  const normalized = frontendProviderBindingsArtifact(f.input, f.plan).gatewayObservation; assert.deepEqual(normalized, f.input.gatewayObservation);
  for (const change of [v => { v.hostMachineId = "0".repeat(32); }, v => { v.gatewayImage = "unreviewed:latest"; },
    v => { v.gatewayConfigurationSha256 = "0".repeat(64); }, v => { v.candidateSha256 = "unknown"; }]) {
    const copy = structuredClone(f.input); change(copy.gatewayObservation); assert.throws(() => frontendProviderBindingsArtifact(copy, f.plan));
  }
});

test("missing historical/provider capabilities remain explicit for every surface without synthetic zero counts", () => {
  const f = fixture(), missing = frontendProviderMissingCapabilities(f.artifact);
  assert.equal(missing.length, f.plan.externalSurfaces.length);
  assert.equal(new Set(missing.map(row => row.surfaceSha256)).size, missing.length);
  assert.equal(missing.find(row => row.provider === "square").capability, "provider-credential-retirement-and-effect-reconciliation");
});

test("missing runtime context refuses before any provider process and records missing capabilities", async () => {
  const f = fixture(), records = [], context = { plan: f.plan, record: (name, value) => records.push({ name, value }), verifyLockedSession: () => {} };
  await assert.rejects(fenceFrontendExternalProducers(context), /FRONTEND_PROVIDER_FENCE_CAPABILITY_MISSING/u);
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

async function protocolFixture(code, task) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "frontend-provider-protocol-"))), app = join(directory, "app");
  try {
    mkdirSync(join(app, "ops/platform/host"), { recursive: true }); mkdirSync(join(app, "src/lib/private-db"), { recursive: true });
    const modules = ["frontend-release-restoration", "frontend-square-effects", "frontend-release-adapters", "frontend-provider-bindings", "frontend-release-inventory", "frontend-release-receipts", "frontend-admission-bootstrap", "frontend-historical-logins", "frontend-bootstrap-compatibility",
      "frontend-migration", "frontend-schema", "source-checkout", "source-policy", "release-inputs", "release"];
    for (const name of modules) copyFileSync(join(root, "ops/platform", `${name}.mjs`), join(app, "ops/platform", `${name}.mjs`));
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
