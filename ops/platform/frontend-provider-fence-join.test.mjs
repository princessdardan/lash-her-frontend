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

function sourceFixture() {
  const f = fixture("resend"), surfaceSha256 = "1";
  f.bindings.historicalRuntimeBindings = f.bindings.historicalRuntimeBindings.filter(row => row.surfaceSha256 === surfaceSha256);
  f.bindings.surfaces = f.bindings.surfaces.filter(row => row.kind !== "direct-caller");
  f.plan.historicalLogins = { retiredLogins: [{ name: "retired", oid: "123" }] };
  const source = { version: 1, status: "FRONTEND_HISTORICAL_SOURCE_VERIFIED", sourceCommit: "b".repeat(40), surfaceSha256,
    configurationRecordSha256: "d".repeat(64), provenanceSha256: "c".repeat(64),
    sourceInventorySha256: "e".repeat(64), requirementsSha256: "f".repeat(64),
    sqlCredentialRequirements: [{ requirementId: "sql-credentials.DATABASE_URL" }],
    providerFamilies: ["contacts", "events"].map(name => ({ familyId: `resend.${name}`, provider: "resend", sourceDisposition: "reachable",
      configurationConditions: [{ requirementId: `resend.${name}.original-configuration` }],
      sqlIntentRequirements: [{ requirementId: `resend.${name}.durable-intents`, tables: ["marketing_contacts"] }],
      untrackedPotentialRequests: [{ requirementId: `resend.${name}.accepted-request-completeness` }] })) };
  source.capabilityClosures = source.providerFamilies.map(family => ({ familyId: family.familyId, disposition: "no-capability-observed",
    ...Object.fromEntries(["sourceCommit", "surfaceSha256", "configurationRecordSha256", "provenanceSha256"].map(key => [key, source[key]])),
    requirementIds: [...["configurationConditions", "sqlIntentRequirements", "untrackedPotentialRequests"].flatMap(key => family[key].map(row => row.requirementId)), "sql-credentials.DATABASE_URL"].sort(), evidenceIds: ["a".repeat(64)] }));
  source.unresolvedFrontendSqlFamilyIds = []; source.unresolvedExternalCapabilityFamilyIds = []; source.unresolvedFamilyIds = [];
  const binding = f.bindings.historicalRuntimeBindings[0]; binding.sourceCommit = source.sourceCommit;
  binding.sourceConfiguration = { provenanceSha256: source.provenanceSha256 };
  f.before = { bindings: [{ ...binding, provenanceSha256: source.provenanceSha256,
    sourceInventorySha256: source.sourceInventorySha256, requirementsSha256: source.requirementsSha256, requirements: source,
    sqlPhysicalBindings: [{ sameSelectedPhysicalDatabase: true, role: { name: "retired", oid: "123" } }],
    sqlEvidence: { ...Object.fromEntries(["sourceCommit", "surfaceSha256", "configurationRecordSha256", "provenanceSha256"].map(key => [key, source[key]])), evidenceSha256: "7".repeat(64), facts: source.sqlCredentialRequirements } }] };
  f.observations.sourceIntentCounts = { marketing_contacts: 0 };
  f.observations.scopedEffects = [{ provider: "resend", surfaceSha256, historicalSourceCommit: source.sourceCommit,
    ...Object.fromEntries(["configurationRecordSha256", "provenanceSha256", "sourceInventorySha256", "requirementsSha256"].map(key => [key, source[key]])),
    databaseRereadVerified: true, observation: { activeExecutions: 0, uncertainEffects: 0, missingRequirementIds: [],
      coveredRequirementIds: source.capabilityClosures.flatMap(row => row.requirementIds) } }];
  return f;
}

test("historical source scope can close a positively excluded provider without unrelated credential retirement", () => {
  const f = sourceFixture();
  assert.equal(join(f).every(row => row.activeExecutions === 0), true);
  assert.equal(join(f).find(row => row.surfaceSha256 === "4").state, "source-inapplicable-and-effects-reconciled");
  assert.equal(join(f).every(row => row.reconciliation.rawInvocationCount === null), true);
  assert.notEqual(f.before.bindings[0].sourceCommit, f.plan.sourceCommit);
});

test("source scope exact requirements, actual SQL contradictions and per-surface context cannot be overridden by counts or flags", () => {
  for (const change of [
    f => { f.before.bindings[0].requirements.capabilityClosures[0].surfaceSha256 = "peer"; },
    f => { delete f.before.bindings[0].requirements.unresolvedExternalCapabilityFamilyIds; },
    f => { f.before.bindings[0].requirements.unresolvedFamilyIds = ["caller-added-residual"]; },
    f => { f.before.bindings[0].requirements.capabilityClosures[0].requirementIds.pop(); },
    f => { f.before.bindings[0].sqlEvidence.facts = []; },
    f => { f.before.bindings[0].sqlPhysicalBindings[0].role.oid = "999"; },
    f => { f.observations.sourceIntentCounts.marketing_contacts = 1; f.observations.scopedEffects[0].observation.missingRequirementIds = ["resend.events.accepted-request-completeness"]; },
    f => { f.observations.scopedEffects[0].surfaceSha256 = "peer"; },
    f => { f.observations.scopedEffects[0].observation.uncertainEffects = 1; },
    f => { f.observations.scopedEffects[0].databaseRereadVerified = false; },
    f => { f.database.admission.active = 1; },
  ]) {
    const f = sourceFixture(); change(f); f.bindings.complete = true; f.observations.allEffectsSettled = true;
    assert.equal(join(f).every(row => row.state === "unfenced"), true);
  }
});

test("new admitted replacement objects do not mutate a retained strict historical scope, while current uncertainty refuses", () => {
  const f = sourceFixture();
  f.database.admission = { newWork: true, recovery: true, active: 3, uncertain: 0 };
  f.observations.sourceIntentCounts = { marketing_contacts: 100 };
  delete f.observations.scopedEffects;
  f.observations.establishedHistoricalFence = { proofSha256: "9".repeat(64), strictEvidenceSha256: f.bindings.surfaces.map(() => "8".repeat(64)), retiredCapabilities: {} };
  assert.equal(join(f).every(row => row.activeExecutions === 0 && row.reconciliation.currentAdmittedActive === 3), true);
  f.database.admission.uncertain = 1;
  assert.equal(join(f).every(row => row.state === "unfenced"), true);
});

test("extra Resend families require their own exact source exclusion rather than invented marketing receipts", () => {
  const f = sourceFixture(), source = f.before.bindings[0].requirements;
  const family = { familyId: "resend.templates", provider: "resend", sourceDisposition: "reachable",
    configurationConditions: [{ requirementId: "resend.templates.original-configuration" }],
    sqlIntentRequirements: [{ requirementId: "resend.templates.durable-intents", tables: ["marketing_contacts"] }],
    untrackedPotentialRequests: [{ requirementId: "resend.templates.accepted-request-completeness" }] };
  source.providerFamilies.push(family);
  source.capabilityClosures.push({ ...source.capabilityClosures[0], familyId: family.familyId,
    requirementIds: ["resend.templates.accepted-request-completeness", "resend.templates.durable-intents", "resend.templates.original-configuration", "sql-credentials.DATABASE_URL"] });
  assert.equal(join(f).every(row => row.activeExecutions === 0), true);
  source.capabilityClosures.pop(); source.unresolvedFrontendSqlFamilyIds = [family.familyId]; source.unresolvedFamilyIds = [family.familyId];
  assert.equal(join(f).every(row => row.state === "unfenced"), true);
});
