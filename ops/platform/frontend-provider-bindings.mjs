// Concrete nonsecret provider targets. This validates identity/coverage, not
// credential retirement, live callback completion or exhaustive account scope.
import { frontendCoordinationHash as hash } from "./frontend-release-inventory.mjs";
import { normalizeFrontendGoogleSnapshot, frontendGoogleSnapshotSha256 } from "./frontend-google-effects.mjs";

export const FRONTEND_VERCEL_TEAM = "team_2Hrn5eMZyZxfAWdmYvyKi9t3";
export const FRONTEND_VERCEL_PROJECT = "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM";
export const FRONTEND_VERCEL_REPOSITORY = "1114139712";
const demand = ok => { if (!ok) throw new Error("FRONTEND_PROVIDER_BINDINGS_REFUSED"); };
const digest = v => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v) && !/^0+$/u.test(v);
const commit = v => typeof v === "string" && /^[a-f0-9]{40}$/u.test(v) && !/^0+$/u.test(v);
const deploymentId = v => typeof v === "string" && /^dpl_[A-Za-z0-9]+$/u.test(v);
const uuid = v => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v);

export function frontendProviderBindingsArtifact(input, plan) {
  demand(input?.version === 1 && input.environment === "staging" && input.actionId === plan.actionId &&
    input.sourceCommit === plan.sourceCommit && input.targetSha256 === plan.targetSha256 && input.teamId === FRONTEND_VERCEL_TEAM &&
    input.projectId === FRONTEND_VERCEL_PROJECT && input.repositoryId === FRONTEND_VERCEL_REPOSITORY &&
    (input.projectState?.productionDeploymentId === null || deploymentId(input.projectState?.productionDeploymentId)) &&
    typeof input.projectState?.nativeSchedulesEnabled === "boolean" &&
    (input.gatewayHost === undefined || input.gatewayHost === null || typeof input.gatewayHost === "string" && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(input.gatewayHost)) &&
    Array.isArray(input.deployments) && input.deployments.length > 0 && input.deployments.length <= 4096 &&
    Array.isArray(input.surfaces) && input.surfaces.length === plan.externalSurfaces.length);
  const deployments = input.deployments.map(row => {
    demand(deploymentId(row?.deploymentId) && (row.sourceCommit === null || commit(row.sourceCommit)) &&
      ["production", "preview"].includes(row.target) && ["QUEUED", "INITIALIZING", "BUILDING", "READY", "ERROR", "CANCELED"].includes(row.state) &&
      Number.isSafeInteger(row.createdAt) && row.createdAt > 0 &&
      (row.url === null || typeof row.url === "string" && /^[a-z0-9][a-z0-9-]*\.vercel\.app$/u.test(row.url)));
    return Object.fromEntries(["deploymentId", "sourceCommit", "target", "createdAt", "url", "state"].map(key => [key, row[key]]));
  }).sort((a, b) => a.deploymentId.localeCompare(b.deploymentId));
  demand(new Set(deployments.map(row => row.deploymentId)).size === deployments.length);
  demand(input.projectState.productionDeploymentId === null || deployments.some(row => row.deploymentId === input.projectState.productionDeploymentId));
  const surfaces = input.surfaces.map(surface => {
    const expected = plan.externalSurfaces.find(row => row.surfaceSha256 === surface?.surfaceSha256);
    demand(expected && surface.kind === expected.kind && surface.identity && typeof surface.identity === "object");
    const id = surface.identity; let identity;
    if (surface.kind === "deployment") {
      demand(id.provider === "vercel" && id.teamId === FRONTEND_VERCEL_TEAM && id.projectId === FRONTEND_VERCEL_PROJECT && deploymentId(id.deploymentId) &&
        deployments.some(row => row.deploymentId === id.deploymentId));
      identity = { provider: "vercel", teamId: id.teamId, projectId: id.projectId, deploymentId: id.deploymentId };
    } else if (surface.kind === "scheduler") {
      demand(id.provider === "vercel" && id.teamId === FRONTEND_VERCEL_TEAM && id.projectId === FRONTEND_VERCEL_PROJECT && id.scheduler === "native-crons");
      identity = { provider: "vercel", teamId: id.teamId, projectId: id.projectId, scheduler: id.scheduler };
    } else {
      demand(typeof id.provider === "string" && /^[a-z][a-z0-9-]{0,39}$/u.test(id.provider) && digest(id.accountSha256) && digest(id.credentialBindingSha256));
      identity = { provider: id.provider, accountSha256: id.accountSha256, credentialBindingSha256: id.credentialBindingSha256 };
    }
    demand(hash(identity) === expected.identitySha256);
    return { surfaceSha256: expected.surfaceSha256, kind: surface.kind, identity };
  }).sort((a, b) => a.surfaceSha256.localeCompare(b.surfaceSha256));
  demand(new Set(surfaces.map(row => row.surfaceSha256)).size === surfaces.length &&
    surfaces.filter(row => row.kind === "scheduler").length === 1 &&
    surfaces.filter(row => row.kind === "deployment").length === deployments.length &&
    new Set(surfaces.filter(row => row.kind === "deployment").map(row => row.identity.deploymentId)).size === deployments.length);
  const result = { version: 1, environment: "staging", actionId: plan.actionId, sourceCommit: plan.sourceCommit, targetSha256: plan.targetSha256,
    teamId: FRONTEND_VERCEL_TEAM, projectId: FRONTEND_VERCEL_PROJECT, repositoryId: FRONTEND_VERCEL_REPOSITORY,
    gatewayHost: input.gatewayHost ?? null,
    projectState: { productionDeploymentId: input.projectState.productionDeploymentId, nativeSchedulesEnabled: input.projectState.nativeSchedulesEnabled }, deployments, surfaces };
  if (input.deploymentRetirement !== undefined) {
    const retirement = input.deploymentRetirement;
    demand(retirement?.preserveBootstrapDeployment === true && Array.isArray(retirement.retireDeploymentIds) && retirement.retireDeploymentIds.length > 0 &&
      Array.isArray(retirement.preserveDeploymentIds));
    const retired = [...retirement.retireDeploymentIds].sort(), preserved = [...retirement.preserveDeploymentIds].sort();
    const selected = [...retired, ...preserved].sort();
    demand(selected.every(deploymentId) && new Set(selected).size === selected.length && selected.length === deployments.length &&
      selected.every((id, index) => id === deployments.map(row => row.deploymentId).sort()[index]) &&
      retired.every(id => deployments.find(row => row.deploymentId === id).sourceCommit !== null));
    result.deploymentRetirement = { preserveBootstrapDeployment: true, retireDeploymentIds: retired, preserveDeploymentIds: preserved };
  }
  if (input.resendRetirement !== undefined) {
    const selected = input.resendRetirement;
    demand(selected?.domainName === "mail.staging.lashher.com" && uuid(selected.domainId) && uuid(selected.retiredKeyId) && uuid(selected.replacementKeyId) &&
      selected.retiredKeyId !== selected.replacementKeyId && surfaces.some(row => row.kind === "provider" && row.identity.provider === "resend"));
    const lists = {};
    for (const key of ["expectedKeyIds", "webhookIds", "knownEmailIds"]) {
      demand(Array.isArray(selected[key]) && selected[key].length <= 4096 && selected[key].every(uuid) && new Set(selected[key]).size === selected[key].length);
      lists[key] = [...selected[key]].sort();
    }
    demand(lists.expectedKeyIds.includes(selected.retiredKeyId) && lists.expectedKeyIds.includes(selected.replacementKeyId));
    result.resendRetirement = { domainId: selected.domainId, domainName: selected.domainName, retiredKeyId: selected.retiredKeyId,
      replacementKeyId: selected.replacementKeyId, ...lists };
  }
  if (input.gatewayObservation !== undefined) {
    const selected = input.gatewayObservation;
    demand(typeof selected?.hostMachineId === "string" && /^[a-f0-9]{32}$/u.test(selected.hostMachineId) && !/^0+$/u.test(selected.hostMachineId) &&
      typeof selected.releaseId === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/u.test(selected.releaseId) && digest(selected.candidateSha256) &&
      digest(selected.gatewayConfigurationSha256) && digest(selected.runtimeConfigurationSha256) && typeof selected.gatewayImage === "string" &&
      /^ghcr\.io\/princessdardan\/lash-her-platform-gateway@sha256:[a-f0-9]{64}$/u.test(selected.gatewayImage));
    result.gatewayObservation = Object.fromEntries(["hostMachineId", "releaseId", "candidateSha256", "gatewayConfigurationSha256", "runtimeConfigurationSha256", "gatewayImage"].map(key => [key, selected[key]]));
  }
  if (input.squareRetirement !== undefined) {
    const selected = input.squareRetirement;
    demand(selected?.environment === "sandbox" && selected.credentialKind === "personal-access-token" && selected.locationId === "LE2H76M5V90AM" &&
      selected.apiVersion === "2026-05-20" && typeof selected.merchantId === "string" && /^[A-Za-z0-9_-]{8,192}$/u.test(selected.merchantId) &&
      typeof selected.applicationId === "string" && /^sandbox-sq0idb-[A-Za-z0-9_-]{1,160}$/u.test(selected.applicationId) &&
      Array.isArray(selected.webhookIds) && selected.webhookIds.length === 1 && selected.webhookIds[0] === "wbhk_b8cf77ce0a5142b38b93715c05ede7d5" &&
      surfaces.some(row => row.kind === "provider" && row.identity.provider === "square") && Array.isArray(selected.effects) && selected.effects.length <= 4096);
    const effects = selected.effects.map(row => {
      demand(["booking-payment-attempt", "product-refund"].includes(row?.recordKind) && uuid(row.recordId) && digest(row.databaseRowSha256));
      return { recordKind: row.recordKind, recordId: row.recordId, databaseRowSha256: row.databaseRowSha256 };
    }).sort((a, b) => `${a.recordKind}/${a.recordId}`.localeCompare(`${b.recordKind}/${b.recordId}`));
    demand(new Set(effects.map(row => `${row.recordKind}/${row.recordId}`)).size === effects.length);
    result.squareRetirement = { environment: "sandbox", credentialKind: "personal-access-token", locationId: selected.locationId,
      apiVersion: selected.apiVersion, merchantId: selected.merchantId, applicationId: selected.applicationId, webhookIds: [...selected.webhookIds], effects };
  }
  if (input.sanityRetirement !== undefined) {
    const selected = input.sanityRetirement;
    demand(selected?.projectId === "7o23yrvk" && selected.dataset === "staging-2026-05-10" &&
      Array.isArray(selected.hooks) && selected.hooks.length <= 4096 &&
      surfaces.some(row => row.kind === "provider" && row.identity.provider === "sanity"));
    const hooks = selected.hooks.map(row => {
      demand(typeof row?.hookId === "string" && /^[A-Za-z0-9_-]{1,192}$/u.test(row.hookId) &&
        ["/api/revalidate", "/api/webhooks/sanity/inventory-sync"].includes(row.path));
      return { hookId: row.hookId, path: row.path };
    }).sort((a, b) => a.hookId.localeCompare(b.hookId));
    demand(new Set(hooks.map(row => row.hookId)).size === hooks.length);
    result.sanityRetirement = { projectId: selected.projectId, dataset: selected.dataset, hooks };
  }
  if (input.googleRetirement !== undefined) {
    const selected = input.googleRetirement;
    const clients = { identity: "185770842371-d3thak0b2btgb77pngj968nvhpjkqmgf.apps.googleusercontent.com",
      calendar: "185770842371-lg0fktlf96u88pnqjnoom83st75btv4d.apps.googleusercontent.com" };
    demand(selected?.projectId === "lash-her-staging-20261022" && selected.projectNumber === "185770842371" &&
      digest(selected.sourceBindingSha256) && digest(selected.databaseSnapshotSha256) && digest(selected.redisSnapshotSha256) &&
      (selected.legacyCalendarSha256 === null || digest(selected.legacyCalendarSha256)) &&
      Array.isArray(selected.clients) && selected.clients.length === 2 && Array.isArray(selected.grants) && selected.grants.length <= 4098 &&
      Array.isArray(selected.calendars) && selected.calendars.length <= 256 &&
      surfaces.some(row => row.kind === "provider" && ["google", "google-calendar", "google-identity"].includes(row.identity.provider)));
    const clientRows = selected.clients.map(row => {
      demand(clients[row?.kind] === row.clientId && (row.verificationOwnerSha256 === null || digest(row.verificationOwnerSha256)) && digest(row.retiredCredentialBindingSha256) &&
        digest(row.replacementCredentialBindingSha256) && row.retiredCredentialBindingSha256 !== row.replacementCredentialBindingSha256);
      return { kind: row.kind, clientId: row.clientId, verificationOwnerSha256: row.verificationOwnerSha256,
        retiredCredentialBindingSha256: row.retiredCredentialBindingSha256, replacementCredentialBindingSha256: row.replacementCredentialBindingSha256 };
    }).sort((a, b) => a.kind.localeCompare(b.kind));
    demand(new Set(clientRows.map(row => row.kind)).size === 2);
    const grants = selected.grants.map(row => {
      demand(typeof row?.grantId === "string" && (/^connection:[a-f0-9-]{36}$/u.test(row.grantId) ||
        ["booking:google-refresh-token:production", "booking:google-refresh-token"].includes(row.grantId)) &&
        digest(row.ownerSha256) && ["retire", "preserve"].includes(row.disposition));
      return { grantId: row.grantId, ownerSha256: row.ownerSha256, disposition: row.disposition };
    }).sort((a, b) => a.grantId.localeCompare(b.grantId));
    demand(new Set(grants.map(row => row.grantId)).size === grants.length);
    const calendars = selected.calendars.map(row => {
      demand(digest(row?.calendarSha256) && (row.grantId === "verification:calendar" || grants.some(grant => grant.grantId === row.grantId)));
      return { calendarSha256: row.calendarSha256, grantId: row.grantId };
    }).sort((a, b) => a.calendarSha256.localeCompare(b.calendarSha256));
    demand(new Set(calendars.map(row => row.calendarSha256)).size === calendars.length);
    const databaseBeforeSnapshot = normalizeFrontendGoogleSnapshot(selected.databaseBeforeSnapshot);
    demand(frontendGoogleSnapshotSha256(databaseBeforeSnapshot) === selected.databaseSnapshotSha256);
    const redisBeforeSnapshot = selected.redisBeforeSnapshot;
    demand(Array.isArray(redisBeforeSnapshot?.grants) && redisBeforeSnapshot.grants.length === 2 &&
      redisBeforeSnapshot.grants[0]?.grantId === "booking:google-refresh-token:production" && redisBeforeSnapshot.grants[1]?.grantId === "booking:google-refresh-token" &&
      redisBeforeSnapshot.grants.every(row => typeof row.present === "boolean") && Array.isArray(redisBeforeSnapshot.stateKeySha256) &&
      redisBeforeSnapshot.stateKeySha256.length <= 4096 && redisBeforeSnapshot.stateKeySha256.every(digest) &&
      new Set(redisBeforeSnapshot.stateKeySha256).size === redisBeforeSnapshot.stateKeySha256.length);
    const redisSnapshot = { grants: redisBeforeSnapshot.grants.map(row => ({ grantId: row.grantId, present: row.present })),
      stateKeySha256: [...redisBeforeSnapshot.stateKeySha256].sort() };
    demand(frontendGoogleSnapshotSha256(redisSnapshot) === selected.redisSnapshotSha256);
    result.googleRetirement = { projectId: selected.projectId, projectNumber: selected.projectNumber,
      sourceBindingSha256: selected.sourceBindingSha256, databaseSnapshotSha256: selected.databaseSnapshotSha256,
      redisSnapshotSha256: selected.redisSnapshotSha256, legacyCalendarSha256: selected.legacyCalendarSha256, clients: clientRows, grants, calendars };
    result.googleRetirement.databaseBeforeSnapshot = databaseBeforeSnapshot;
    result.googleRetirement.redisBeforeSnapshot = redisSnapshot;
  }
  for (const provider of ["highlevel", "chitchats"]) {
    const key = provider === "highlevel" ? "highlevelRetirement" : "chitchatsRetirement";
    if (input[key] === undefined) continue;
    const selected = input[key];
    const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,192}$/u.test(value);
    demand(selected?.environment === "staging" &&
      ["sourceBindingSha256", "databaseSnapshotSha256", "retiredCredentialBindingSha256", "replacementCredentialBindingSha256"].every(key => digest(selected[key])) &&
      selected.retiredCredentialBindingSha256 !== selected.replacementCredentialBindingSha256 &&
      surfaces.some(row => row.kind === "provider" && row.identity.provider === provider));
    const row = { environment: "staging", credentialKind: selected.credentialKind,
      ...Object.fromEntries(["sourceBindingSha256", "databaseSnapshotSha256", "retiredCredentialBindingSha256", "replacementCredentialBindingSha256"].map(key => [key, selected[key]])) };
    const lists = provider === "chitchats" ? ["expectedProviderShipmentIds"] : ["expectedProviderContactIds", "expectedWorkflowIds"];
    for (const list of lists) {
      demand(Array.isArray(selected[list]) && selected[list].length <= 4096 && selected[list].every(id) && new Set(selected[list]).size === selected[list].length);
      row[list] = [...selected[list]].sort();
    }
    if (provider === "chitchats") {
      demand(selected.credentialKind === "personal-access-token" && id(selected.clientId));
      row.clientId = selected.clientId;
    } else {
      demand(["private-integration-token", "oauth-installation"].includes(selected.credentialKind) && id(selected.locationId) &&
        selected.locationId !== "vd09FLBpPLXuHb5Tnhn4" && id(selected.companyId));
      row.locationId = selected.locationId; row.companyId = selected.companyId;
      if (selected.credentialKind === "oauth-installation") {
        demand(id(selected.appId) && id(selected.oauthClientId)); row.appId = selected.appId; row.oauthClientId = selected.oauthClientId;
      } else { demand(id(selected.retiredIntegrationId)); row.retiredIntegrationId = selected.retiredIntegrationId; }
    }
    result[key] = row;
  }
  if (plan.restoration !== undefined) demand(result.gatewayObservation && hash(result.gatewayObservation) === plan.restoration.gatewayBindingSha256);
  return result;
}

export function prepareFrontendProviderBindings(input, plan) {
  const result = frontendProviderBindingsArtifact(input, plan);
  demand(digest(plan.providerBindingsSha256) && hash(result) === plan.providerBindingsSha256);
  return result;
}

export function frontendProviderMissingCapabilities(bindings) {
  return bindings.surfaces.map(surface => ({ surfaceSha256: surface.surfaceSha256,
    provider: surface.identity.provider, kind: surface.kind,
    capability: surface.kind === "deployment" ? "historical-deployment-database-provider-and-callback-fence" :
      surface.kind === "scheduler" ? "running-native-invocation-and-deferred-effects-reconciliation" :
        surface.kind === "direct-caller" ? "direct-caller-credential-retirement-and-effect-reconciliation" :
          "provider-credential-retirement-and-effect-reconciliation" }));
}
