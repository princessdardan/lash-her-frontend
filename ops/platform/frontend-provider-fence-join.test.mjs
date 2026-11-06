import assert from "node:assert/strict";
import test from "node:test";
import { deriveFrontendProviderFence } from "./frontend-provider-fence-join.mjs";

function fixture(provider = "chitchats") {
  const plan = { sourceCommit: "a".repeat(40), candidateCoverage: [{ disposition: "admitted" }] };
  const bindings = { surfaces: [
    { surfaceSha256: "1", kind: "deployment", identity: { provider: "vercel", deploymentId: "dpl_previous" } },
    { surfaceSha256: "2", kind: "direct-caller", identity: { provider: "manual" } },
    { surfaceSha256: "3", kind: "scheduler", identity: { provider: "vercel" } },
    { surfaceSha256: "4", kind: "provider", identity: { provider } }] };
  bindings.historicalRuntimeBindings = ["1", "2"].map(surfaceSha256 => ({ surfaceSha256, sourceCommit: plan.sourceCommit,
    configurationRecordSha256: "d".repeat(64), databaseRole: { name: "retired", oid: "123" }, providerCredentials: [] }));
  const before = { bindings: bindings.historicalRuntimeBindings.map(row => ({ ...row,
    samePhysicalDatabaseVerified: true, privateRetiredCredentialEqualityVerified: true })) };
  const database = { retiredLoginsDenied: true, retiredRolesDedicated: true, admissionOwnerVerified: true, selectedSessions: 0, admission: { active: 0, uncertain: 0 } };
  const observations = { vercel: { reviewedInventoryMatches: true, reviewedProjectMatches: true, projectPaginationComplete: true,
    aliasJobActive: false, projectState: { cronsEnabled: false }, historicalIngressRetiredDeploymentIds: ["dpl_previous"] },
    chitchats: { retiredCredentialDenied: true, replacementReadVerified: true, providerInventoryComplete: true,
      activeExecutions: 0, uncertainEffects: 0, knownUnresolvedEffects: 0, unmappedProviderShipments: 0,
      knownEffects: [{ storedOutcomeConsistent: true, providerStatus: "in_transit" }], knownJobs: [{ storedOutcomeConsistent: true }],
      deferredPhysicalShipmentIds: ["accepted-shipment"], futurePollingAuthorized: false },
    retirements: { chitchats: { status: "STAGING_CREDENTIAL_RETIRED_EFFECT_SCOPE_OBSERVED" } } };
  return { plan, bindings, observations, database, before };
}
const join = f => deriveFrontendProviderFence(f.plan, f.bindings, f.observations, f.database, f.before);

test("fixed predicate derives effect-capable zero only from complete source/capability, SQL, ledger, ingress and settled operation evidence", () => {
  const result = join(fixture());
  assert.equal(result.every(row => row.activeExecutions === 0 && row.uncertainEffects === 0), true);
  assert.equal(result.every(row => row.reconciliation.rawInvocationCount === null), true);
  assert.equal(result.find(row => row.surfaceSha256 === "1").state, "retired-and-effects-reconciled");
  // Physical carrier delivery is intentionally outside active API execution.
  assert.equal(result.find(row => row.surfaceSha256 === "4").state, "credentials-retired-and-effects-reconciled");
});

test("each independent historical or provider gap refuses without replacing it with a credential-denial count", () => {
  for (const change of [
    f => { f.before.bindings.pop(); }, f => { f.before.bindings[0].sourceCommit = "b".repeat(40); },
    f => { f.before.bindings[0].samePhysicalDatabaseVerified = false; }, f => { f.database.retiredLoginsDenied = false; },
    f => { f.database.selectedSessions = 1; }, f => { f.database.retiredRolesDedicated = false; }, f => { f.database.admissionOwnerVerified = false; }, f => { f.database.admission.active = 1; }, f => { f.database.admission.uncertain = 1; },
    f => { f.observations.vercel.projectState.cronsEnabled = true; }, f => { f.observations.vercel.reviewedInventoryMatches = false; },
    f => { f.observations.chitchats.providerInventoryComplete = false; }, f => { f.observations.chitchats.knownJobs[0].storedOutcomeConsistent = false; },
    f => { f.observations.chitchats.retiredCredentialDenied = false; }, f => { f.observations.retirements = {}; },
    f => { f.plan.candidateCoverage = []; },
  ]) {
    const f = fixture(); change(f);
    f.bindings.fenced = true; f.observations.chitchats.historicalWritersFenced = true;
    assert.equal(join(f).every(row => row.state === "unfenced" && row.activeExecutions === null && row.uncertainEffects === null), true);
  }
});

test("known HighLevel entity or workflow-definition receipts cannot erase historical execution and delivery uncertainty", () => {
  for (const provider of ["highlevel", "resend", "square", "unreviewed-provider"]) {
    const f = fixture(provider);
    f.observations[provider] = { status: "KNOWN_EFFECTS_OBSERVED", retiredCredentialDenied: true, activeExecutions: 0, uncertainEffects: 0,
      complete: true, allEffectsSettled: true };
    assert.equal(join(f).every(row => row.state === "unfenced"), true);
  }
});

test("Google zero needs original calibrated retirement, every actual grant/event/continuation and independent source-capability evidence", () => {
  const f = fixture("google");
  f.observations.google = { status: "GOOGLE_STAGING_SCOPES_OBSERVED", uncertainEffects: 0, pendingOAuthContinuations: 0, redisPaginationComplete: true,
    clients: ["identity", "calendar"].map(kind => ({ kind, retiredSecretDenied: true, replacementClientAuthenticationVerified: true })),
    grants: [{ stateVerified: true }], events: [{ unresolvedEffects: 0 }] };
  f.observations.retirements.google = { status: "GOOGLE_SELECTED_GRANTS_RETIRED_CONTINUATIONS_CLOSED", runtimeReplacementBindingVerified: true };
  assert.equal(join(f).every(row => row.activeExecutions === 0), true);
  f.observations.google.grants[0].stateVerified = false;
  assert.equal(join(f).every(row => row.activeExecutions === null), true);
});

test("verified prior historical receipts permit current admitted continuation without freezing replacement provider objects or active counts", () => {
  const f = fixture();
  f.database.admission = { newWork: true, recovery: true, active: 3, uncertain: 0 };
  f.observations.chitchats = { historicalCapabilitiesDenied: true, replacementReadVerified: true, currentProviderObjectCount: 100 };
  assert.equal(join(f).every(row => row.state === "unfenced"), true);
  f.observations.establishedHistoricalFence = { proofSha256: "e".repeat(64), strictEvidenceSha256: f.bindings.surfaces.map(() => "f".repeat(64)) };
  const rows = join(f);
  assert.equal(rows.every(row => row.activeExecutions === 0 && row.reconciliation.currentAdmittedActive === 3), true);
  f.database.admission.uncertain = 1;
  assert.equal(join(f).every(row => row.state === "unfenced"), true);
  f.database.admission.uncertain = 0; f.observations.chitchats.historicalCapabilitiesDenied = false;
  assert.equal(join(f).every(row => row.state === "unfenced"), true);
});
