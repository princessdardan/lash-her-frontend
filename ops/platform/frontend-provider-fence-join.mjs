import { createHash } from "node:crypto";
const sourceReceiptHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Each proof is bound to one original surface and source revision. The source
// observer creates these facts; public caller booleans cannot provide them.
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const requirementIds = family => ["configurationConditions", "sqlIntentRequirements", "untrackedPotentialRequests"]
  .flatMap(key => family[key].map(row => row.requirementId)).sort();
function exactClosure(source, family) {
  const rows = source.capabilityClosures.filter(row => row.familyId === family.familyId);
  if (rows.length !== 1) return false;
  const row = rows[0], ids = [...requirementIds(family), ...source.sqlCredentialRequirements.map(row => row.requirementId)].sort();
  return ["sourceCommit", "surfaceSha256", "configurationRecordSha256", "provenanceSha256"].every(key => row[key] === source[key]) &&
    ["no-capability-observed", "absent-from-verified-source"].includes(row.disposition) &&
    (row.disposition !== "absent-from-verified-source" || family.sourceDisposition === "absent-from-verified-source") &&
    equal(row.requirementIds, ids) && new Set(ids).size === ids.length && Array.isArray(row.evidenceIds) && row.evidenceIds.length > 0 &&
    row.evidenceIds.every(digest) && equal(row.evidenceIds, [...new Set(row.evidenceIds)].sort());
}

export function deriveFrontendProviderFence(plan, bindings, observations, database, capabilityBefore) {
  if (!bindings.historicalRuntimeBindings?.some(row => row.sourceConfiguration))
    return deriveLegacyFrontendProviderFence(plan, bindings, observations, database, capabilityBefore);
  const historical = bindings.surfaces.filter(row => ["deployment", "direct-caller"].includes(row.kind));
  const missing = [], sources = [];
  for (const surface of historical) {
    const binding = bindings.historicalRuntimeBindings.find(row => row.surfaceSha256 === surface.surfaceSha256);
    const observed = capabilityBefore?.bindings?.find(row => row.surfaceSha256 === surface.surfaceSha256);
    const source = observed?.requirements;
    const sql = observed?.sqlEvidence;
    const valid = binding?.sourceConfiguration && source?.status === "FRONTEND_HISTORICAL_SOURCE_VERIFIED" &&
      ["sourceCommit", "surfaceSha256", "configurationRecordSha256"].every(key => source[key] === binding[key] && observed[key] === binding[key]) &&
      source.provenanceSha256 === binding.sourceConfiguration.provenanceSha256 && observed.provenanceSha256 === source.provenanceSha256 &&
      source.sourceInventorySha256 === observed.sourceInventorySha256 && source.requirementsSha256 === observed.requirementsSha256 &&
      Array.isArray(source.providerFamilies) && Array.isArray(source.capabilityClosures) && Array.isArray(source.sqlCredentialRequirements) &&
      sql?.sourceCommit === source.sourceCommit && sql.surfaceSha256 === source.surfaceSha256 &&
      sql.configurationRecordSha256 === source.configurationRecordSha256 && sql.provenanceSha256 === source.provenanceSha256 &&
      digest(sql.evidenceSha256) && equal(sql.facts?.map(row => row.requirementId).sort(), source.sqlCredentialRequirements.map(row => row.requirementId).sort()) &&
      observed.sqlPhysicalBindings.every(row => !row.sameSelectedPhysicalDatabase || plan.historicalLogins.retiredLogins.some(role =>
        role.name === row.role?.name && role.oid === row.role?.oid));
    if (!valid) missing.push(surface.surfaceSha256); else sources.push(source);
  }
  const ledgerZero = database.admissionOwnerVerified === true && database.admission.active === 0 && database.admission.uncertain === 0;
  const established = observations.establishedHistoricalFence;
  const continuation = database.admissionOwnerVerified === true && database.admission.uncertain === 0 && digest(established?.proofSha256) &&
    established.strictEvidenceSha256?.length === bindings.surfaces.length && established.strictEvidenceSha256.every(digest);
  const sqlDenied = database.retiredLoginsDenied === true && database.retiredRolesDedicated === true && database.selectedSessions === 0;
  const ingress = observations.vercel?.reviewedInventoryMatches === true && observations.vercel.reviewedProjectMatches === true &&
    observations.vercel.projectPaginationComplete === true && observations.vercel.aliasJobActive === false && observations.vercel.projectState?.cronsEnabled === false;
  const families = sources.flatMap(source => source.providerFamilies.map(family => {
    const tables = [...new Set(family.sqlIntentRequirements.flatMap(row => row.tables ?? []))];
    const empty = tables.every(table => observations.sourceIntentCounts?.[table] === 0);
    const closure = exactClosure(source, family);
    const scoped = observations.scopedEffects?.find(row => row.surfaceSha256 === source.surfaceSha256 && row.provider === family.provider &&
      row.historicalSourceCommit === source.sourceCommit && row.configurationRecordSha256 === source.configurationRecordSha256 &&
      row.provenanceSha256 === source.provenanceSha256 && row.sourceInventorySha256 === source.sourceInventorySha256 &&
      row.requirementsSha256 === source.requirementsSha256 && row.databaseRereadVerified === true);
    const effect = scoped?.observation;
    const ids = requirementIds(family), covered = new Set(effect?.coveredRequirementIds ?? []);
    const domainZero = effect?.activeExecutions === 0 && effect?.uncertainEffects === 0 &&
      Array.isArray(effect.missingRequirementIds) && effect.missingRequirementIds.length === 0 && ids.every(id => covered.has(id));
    // Known-scope absence requires both original no-capability proof and actual
    // source-declared intent contradiction checks. Domain receipts never erase
    // a different historical surface's accepted-request requirements.
    const noCapability = closure && empty && (!["square", "resend", "highlevel", "chitchats"].includes(family.provider) || domainZero);
    const retained = continuation && (noCapability || effect === undefined);
    const settled = continuation ? retained : noCapability || domainZero && !(closure && !empty);
    return { surfaceSha256: source.surfaceSha256, sourceCommit: source.sourceCommit, provider: family.provider, familyId: family.familyId,
      sourceInventorySha256: source.sourceInventorySha256, requirementsSha256: source.requirementsSha256,
      disposition: noCapability ? "source-inapplicable-and-effects-reconciled" : settled ? "observed-effects-reconciled" : "source-requirements-unresolved",
      coveredRequirementIds: settled ? ids : ids.filter(id => covered.has(id)), missingRequirementIds: settled ? [] : ids.filter(id => !covered.has(id)),
      sqlContradictionCheckVerified: empty, settled };
  }));
  // After reopening, the established strict proof owns historical effects.
  // New current-source rows are not retroactively put into that old scope.
  const retiredReadbacks = observations.establishedHistoricalFence?.retiredCapabilities;
  const continuationDenied = continuation && bindings.surfaces.filter(row => row.kind === "provider").every(surface => {
    const name = ["google-identity", "google-calendar"].includes(surface.identity.provider) ? "google" : surface.identity.provider;
    const relevant = families.filter(row => row.provider === name);
    const allAbsent = relevant.length > 0 && relevant.every(row => exactClosure(sources.find(source => source.surfaceSha256 === row.surfaceSha256),
      sources.find(source => source.surfaceSha256 === row.surfaceSha256).providerFamilies.find(family => family.familyId === row.familyId)));
    return allAbsent || retiredReadbacks?.[name]?.historicalCapabilitiesDenied === true;
  });
  const coverage = missing.length === 0 && sources.length === historical.length && families.length > 0 &&
    bindings.surfaces.filter(row => row.kind === "provider").every(row => families.some(family => family.provider ===
      (["google-identity", "google-calendar"].includes(row.identity.provider) ? "google" : row.identity.provider)));
  const controlled = provider => {
    const rows = families.filter(row => row.provider === provider);
    if (rows.every(row => row.disposition === "source-inapplicable-and-effects-reconciled")) return true;
    const actual = observations[provider], receipt = observations.retirements?.[provider];
    if (provider === "square") return actual?.retiredCredentialDenied === true && actual.webhooks?.every(row => row.enabled === false) &&
      receipt?.status === "STAGING_SQUARE_CREDENTIAL_DENIED_KNOWN_EFFECTS_OBSERVED" && receipt.runtimeReplacementBindingVerified === true;
    if (provider === "resend") return actual?.retiredCredentialDenied === true && actual.webhooks?.every(row => row.status === "disabled") &&
      receipt?.status === "STAGING_RESEND_CREDENTIAL_RETIRED_EFFECTS_UNRESOLVED" && receipt.runtimeReplacementBindingVerified === true;
    if (["highlevel", "chitchats"].includes(provider)) return actual?.retiredCredentialDenied === true && actual.replacementReadVerified === true &&
      receipt?.status === "STAGING_CREDENTIAL_RETIRED_EFFECT_SCOPE_OBSERVED" && (provider !== "highlevel" || actual.retiredRefreshDenied === true);
    if (provider === "google") return receipt?.status === "GOOGLE_SELECTED_GRANTS_RETIRED_CONTINUATIONS_CLOSED" &&
      receipt.runtimeReplacementBindingVerified === true && actual?.uncertainEffects === 0;
    if (provider === "sanity") return actual?.activeExecutions === 0 && actual.uncertainEffects === 0 && actual.hooks?.every(row => row.disabled && row.disabledByUser);
    return false;
  };
  const controls = [...new Set(families.map(row => row.provider))].every(controlled);
  const effects = continuation ? continuationDenied : controls && families.every(row => row.settled);
  const all = coverage && effects && sqlDenied && ingress && (ledgerZero || continuation);
  return bindings.surfaces.map(surface => {
    const name = ["google-identity", "google-calendar"].includes(surface.identity.provider) ? "google" : surface.identity.provider;
    const relevant = families.filter(row => surface.kind === "provider" ? row.provider === name :
      ["deployment", "direct-caller"].includes(surface.kind) ? row.surfaceSha256 === surface.surfaceSha256 : true);
    const absence = relevant.length > 0 && relevant.every(row => row.disposition === "source-inapplicable-and-effects-reconciled");
    const retired = surface.kind !== "deployment" || observations.vercel.historicalIngressRetiredDeploymentIds?.includes(surface.identity.deploymentId);
    return { surfaceSha256: surface.surfaceSha256, state: !all ? "unfenced" : surface.kind === "provider" ?
      (absence ? "source-inapplicable-and-effects-reconciled" : "credentials-retired-and-effects-reconciled") : surface.kind === "scheduler" ?
        "disabled-and-running-executions-reconciled" : retired ? "retired-and-effects-reconciled" : "admission-bound-and-effects-reconciled",
      activeExecutions: all ? 0 : null, uncertainEffects: all ? 0 : null,
      reconciliation: { rawInvocationCount: null, executionScope: "source-specific-effect-capable-historical-writers",
        physicalDatabaseLoginsDenied: sqlDenied, admittedActiveAndUncertainZero: ledgerZero, currentAdmittedActive: database.admission.active,
        historicalAcceptedEffectDrainVerified: ledgerZero || continuation, historicalIngressVerified: ingress,
        historicalSourceCoverageVerified: coverage, missingBindingSurfaceSha256: missing,
        sourceFamilies: surface.kind === "scheduler" ? relevant.map(row => ({ surfaceSha256: row.surfaceSha256, familyId: row.familyId,
          settled: row.settled, receiptSha256: sourceReceiptHash(row) })) : relevant,
        priorStrictHistoricalFenceSha256: continuation ? established.proofSha256 : null, historicalCapabilityReadbacksVerified: continuationDenied,
        effectEvidenceComplete: effects } };
  });
}

// Fixed source predicate over actual observations. These inputs are assembled
// by the source-owned observer, never accepted as a caller's fence certificate.
function deriveLegacyFrontendProviderFence(plan, bindings, observations, database, capabilityBefore) {
  const historical = bindings.surfaces.filter(row => ["deployment", "direct-caller"].includes(row.kind));
  const bound = capabilityBefore?.bindings ?? [];
  const missingBindings = historical.filter(surface => {
    const selected = bindings.historicalRuntimeBindings?.find(row => row.surfaceSha256 === surface.surfaceSha256);
    return !selected || !bound.some(row => row.surfaceSha256 === surface.surfaceSha256 &&
      row.configurationRecordSha256 === selected.configurationRecordSha256 && row.sourceCommit === selected.sourceCommit &&
      row.databaseRole?.name === selected.databaseRole.name && row.databaseRole?.oid === selected.databaseRole.oid &&
      JSON.stringify(row.providerCredentials) === JSON.stringify(selected.providerCredentials) &&
      row.samePhysicalDatabaseVerified === true && row.privateRetiredCredentialEqualityVerified === true);
  });
  // The reviewed candidate coverage does not cover an older source revision.
  // No current configuration flag or matching provider key repairs that gap.
  const priorSource = historical.filter(surface => bound.find(row => row.surfaceSha256 === surface.surfaceSha256)?.sourceCommit !== plan.sourceCommit);
  const ledgerZero = database.admissionOwnerVerified === true && database.admission.active === 0 && database.admission.uncertain === 0;
  const established = observations.establishedHistoricalFence;
  const historicalContinuation = (database.admission.newWork === true || database.admission.recovery === true) &&
    database.admissionOwnerVerified === true && database.admission.uncertain === 0 && /^[a-f0-9]{64}$/u.test(established?.proofSha256 ?? "") &&
    Array.isArray(established.strictEvidenceSha256) && established.strictEvidenceSha256.length === bindings.surfaces.length &&
    established.strictEvidenceSha256.every(value => /^[a-f0-9]{64}$/u.test(value));
  const historicalAdmissionDrained = ledgerZero || historicalContinuation;
  const databaseDenied = database.retiredLoginsDenied === true && database.retiredRolesDedicated === true && database.selectedSessions === 0;
  const covered = missingBindings.length === 0 && priorSource.length === 0 && plan.candidateCoverage.length > 0;
  const vercel = observations.vercel;
  const ingress = vercel?.reviewedInventoryMatches === true && vercel.reviewedProjectMatches === true &&
    vercel.projectPaginationComplete === true && vercel.aliasJobActive === false && vercel.projectState?.cronsEnabled === false;
  const shared = { rawInvocationCount: null, executionScope: "effect-capable-writers-under-source-admission-and-denied-capabilities",
    physicalDatabaseLoginsDenied: databaseDenied, admittedActiveAndUncertainZero: ledgerZero,
    historicalAcceptedEffectDrainVerified: historicalAdmissionDrained, currentAdmittedActive: database.admission.active,
    priorStrictHistoricalFenceSha256: historicalContinuation ? established.proofSha256 : null,
    currentSourceAdmissionCoverageVerified: covered, historicalIngressVerified: ingress,
    missingBindingSurfaceSha256: missingBindings.map(row => row.surfaceSha256),
    historicalSourceOutsideCandidateCoverageSha256: priorSource.map(row => row.surfaceSha256) };
  const providers = bindings.surfaces.filter(row => row.kind === "provider").map(surface => {
    const name = surface.identity.provider, observed = observations[name], gaps = [];
    let settled = false;
    if (!observed || observed.status === "OBSERVATION_FAILED_REQUIRES_REVIEW") gaps.push("actual-selected-provider-observation-missing");
    else if (historicalContinuation && ["chitchats", "google", "google-identity", "google-calendar", "sanity"].includes(name)) {
      settled = observed.historicalCapabilitiesDenied === true;
      if (!settled) gaps.push("previously-fenced-historical-capability-denial-no-longer-verified");
    } else if (name === "chitchats") {
      settled = observations.retirements?.chitchats?.status === "STAGING_CREDENTIAL_RETIRED_EFFECT_SCOPE_OBSERVED" &&
        observed.retiredCredentialDenied === true && observed.replacementReadVerified === true &&
        observed.providerInventoryComplete === true && observed.activeExecutions === 0 && observed.uncertainEffects === 0 &&
        observed.knownUnresolvedEffects === 0 && observed.unmappedProviderShipments === 0 &&
        Array.isArray(observed.knownEffects) && observed.knownEffects.every(row => row.storedOutcomeConsistent === true) &&
        Array.isArray(observed.knownJobs) && observed.knownJobs.every(row => row.storedOutcomeConsistent === true);
      if (!settled) gaps.push("shipment-or-potential-operation-receipts-unsettled");
    } else if (["google", "google-identity", "google-calendar"].includes(name)) {
      settled = observations.retirements?.google?.status === "GOOGLE_SELECTED_GRANTS_RETIRED_CONTINUATIONS_CLOSED" &&
        observations.retirements.google.runtimeReplacementBindingVerified === true &&
        observed.uncertainEffects === 0 && observed.pendingOAuthContinuations === 0 && observed.redisPaginationComplete === true &&
        Array.isArray(observed.clients) && observed.clients.length === 2 && observed.clients.every(row => row.retiredSecretDenied === true && row.replacementClientAuthenticationVerified === true) &&
        Array.isArray(observed.grants) && observed.grants.every(row => row.stateVerified === true) &&
        Array.isArray(observed.events) && observed.events.every(row => row.unresolvedEffects === 0);
      if (!settled) gaps.push("google-client-grant-calendar-or-continuation-receipts-unsettled");
    } else if (name === "sanity") {
      settled = observations.retirements?.sanity?.status === "SANITY_HOOKS_DISABLED_CREDENTIAL_RETIREMENT_PENDING" &&
        observed.hookInventoryComplete === true && observed.deliveryPaginationComplete === true &&
        observed.activeExecutions === 0 && observed.uncertainEffects === 0 && Array.isArray(observed.hooks) &&
        observed.hooks.every(row => row.disabled === true && row.disabledByUser === true);
      if (!settled) gaps.push("selected-hook-ingress-or-delivery-receipts-unsettled");
    } else if (name === "highlevel") gaps.push("historical-workflow-execution-downstream-delivery-and-webhook-inventory-incomplete");
    else if (name === "resend") gaps.push("contact-and-marketing-operation-reconciliation-incomplete");
    else if (name === "square") gaps.push("complete-financial-intent-and-accepted-provider-request-inventory-incomplete");
    else gaps.push("selected-provider-source-applicability-and-control-not-qualified");
    if (!covered) gaps.push("historical-source-and-physical-capability-coverage-incomplete");
    if (!databaseDenied) gaps.push("historical-sql-login-or-session-fence-unverified");
    if (!historicalAdmissionDrained) gaps.push("active-or-uncertain-admitted-operations");
    if (!ingress) gaps.push("historical-deployment-or-scheduler-ingress-unverified");
    return { surfaceSha256: surface.surfaceSha256, provider: name, settled: settled && gaps.length === 0, gaps };
  });
  const allProvidersSettled = providers.length > 0 && providers.every(row => row.settled);
  return bindings.surfaces.map(surface => {
    const provider = providers.find(row => row.surfaceSha256 === surface.surfaceSha256);
    const historicalRetired = surface.kind !== "deployment" || vercel?.historicalIngressRetiredDeploymentIds?.includes(surface.identity.deploymentId);
    const fenced = provider ? provider.settled : covered && databaseDenied && historicalAdmissionDrained && ingress && allProvidersSettled;
    return { surfaceSha256: surface.surfaceSha256, reconciliation: { ...shared,
      providerObservations: provider ? [provider] : providers,
      effectEvidenceComplete: provider?.settled ?? allProvidersSettled,
      credentialRetirementScope: surface.identity.provider === "sanity" ? "historical-frontend-SQL-capability-and-selected-hook-ingress" : "selected-historical-physical-SQL-and-provider-capabilities" },
      state: !fenced ? "unfenced" : surface.kind === "provider" ? "credentials-retired-and-effects-reconciled" :
        surface.kind === "scheduler" ? "disabled-and-running-executions-reconciled" :
          historicalRetired ? "retired-and-effects-reconciled" : "admission-bound-and-effects-reconciled",
      activeExecutions: fenced ? 0 : null, uncertainEffects: fenced ? 0 : null };
  });
}
