// Fixed source predicate over actual observations. These inputs are assembled
// by the source-owned observer, never accepted as a caller's fence certificate.
export function deriveFrontendProviderFence(plan, bindings, observations, database, capabilityBefore) {
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
