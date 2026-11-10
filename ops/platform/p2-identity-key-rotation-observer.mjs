import { isDeepStrictEqual } from "node:util";
import { observeRecoveryPhysical } from "./p2-recovery-current-probe.mjs";
import { requireQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SERVICES = Object.freeze(["community-api", "community-tls", "community-worker", "course-api", "course-export-cleanup",
  "course-media", "course-publisher", "course-snapshot", "course-tls", "gateway"]);
const BOUNDARY_CHECKS = Object.freeze(["private-application-credential-required", "private-community-peer-denied",
  "private-course-tls-catalog", "public-metrics-hidden", "public-tls-missing-workload-denied"]);

export class RotationBoundaryFailure extends Error {
  constructor(check) { super("P2_IDENTITY_ROTATION_BOUNDARY_REFUSED"); this.check = check; }
}
const requireBoundary = (condition, check) => { if (!condition) throw new RotationBoundaryFailure(check); };
const closed = (value, fields) => Boolean(value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...fields].sort().join());

export async function observeIdentityRotationBoundary(context, dependencies = {}) {
  requireBoundary(closed(context, ["version", "environment", "actionId", "phase", "bindingSha256", "sourceCommit",
    "candidateSha256", "runtimeConfigurationSha256", "frontendConfigurationSha256", "frontendSession", "hostScope"])
    && context.version === 1 && context.environment === "staging" && /^p2-key-rotation-[a-z0-9-]{1,40}$/u.test(context.actionId)
    && [context.bindingSha256, context.candidateSha256, context.runtimeConfigurationSha256,
      context.frontendConfigurationSha256].every(value => SHA.test(value))
    && COMMIT.test(context.sourceCommit) && ["baseline", "overlap", "current-only", "containment"].includes(context.phase),
  "boundary-context");
  const frontend = context.frontendSession;
  requireBoundary(frontend && typeof frontend.verify === "function" && frontend.probe?.receipt?.sourceCommit === context.sourceCommit
    && frontend.receipt?.candidateSha256 === context.candidateSha256, "frontend-session-binding");
  const host = context.hostScope;
  requireBoundary(host && typeof host.verify === "function" && host.sourceCommit === context.sourceCommit
    && host.candidateSha256 === context.candidateSha256 && host.bindingSha256 === context.bindingSha256, "host-scope-binding");
  await frontend.verify(); host.verify();
  const managed = frontend.probe.version === 2 || frontend.receipt.version === 2;
  let physical;
  if (managed) {
    const { probe, receipt } = frontend;
    requireQualificationTargetProfile(profile, probe, receipt, probe.plan);
    const initial = probe.plan?.initialEpoch;
    requireBoundary(probe.version === 2 && receipt.version === 2 && receipt.status === "P2_CERTIFICATION_DATABASE_CURRENT"
      && probe.receipt === receipt && probe.plan?.mode === "contain-native" && probe.plan.certificationActionId === context.actionId
      && receipt.planSha256 === probe.plan.planSha256 && receipt.candidateSha256 === probe.plan.candidateSha256
      && probe.replacementRelease && isDeepStrictEqual(probe.replacementRelease, receipt.replacementRelease)
      && /^[1-9][0-9]{0,17}$/u.test(initial ?? "") && receipt.admission?.epoch === initial
      && SHA.test(receipt.journalSha256 ?? "") && typeof frontend.currentEpoch === "function" && typeof frontend.observeCurrent === "function",
    "managed-frontend-session-binding");
    const epoch = frontend.currentEpoch();
    requireBoundary(typeof epoch === "string" && [0n, 2n, 4n, 6n].some(delta => String(BigInt(initial) + delta) === epoch),
      "managed-frontend-epoch");
    physical = await frontend.observeCurrent();
    requireQualificationTargetProfile(profile, physical);
    requireBoundary(physical.version === 2 && physical.marker === probe.marker && physical.backendPid === probe.backendPid
      && physical.backendStart === probe.backendStart && physical.environment === "staging"
      && physical.releaseId === receipt.releaseId && physical.targetSha256 === receipt.targetSha256
      && physical.journalSha256 === receipt.journalSha256 && physical.admission?.epoch === epoch
      && SHA.test(physical.witnessSha256 ?? "")
      && physical.effectiveLoginBoundaryVerified === true && physical.predecessorRuntimeRoleAbsent === true
      && isDeepStrictEqual(physical.replacementRelease, probe.replacementRelease), "managed-frontend-physical-fence");
  } else {
    requireBoundary(!Object.hasOwn(frontend.probe, "qualificationTargetProfile")
      && !Object.hasOwn(frontend.receipt, "qualificationTargetProfile"), "frontend-session-binding");
    physical = await (dependencies.observePhysical ?? observeRecoveryPhysical)(
      { ...frontend.probe, operation: "verify-schema" }, dependencies.physicalDependencies);
  }
  requireBoundary(physical?.status === "P2_FRONTEND_PHYSICAL_LOCK_VERIFIED"
    && physical.sourceCommit === context.sourceCommit && physical.admission?.newWork === false
    && physical.admission?.recovery === false && physical.admission?.active === 0 && physical.admission?.uncertain === 0,
  "frontend-physical-fence");
  const runtime = await dependencies.observeRuntime();
  requireBoundary(closed(runtime, ["configurationSha256", "nativeSchedulesEnabled", "businessSchedulesEnabled", "containers",
    "courseCurrent", "communityCurrent", "boundaryChecks"])
    && runtime.configurationSha256 === context.runtimeConfigurationSha256 && runtime.nativeSchedulesEnabled === false
    && runtime.businessSchedulesEnabled === false && runtime.courseCurrent === true && runtime.communityCurrent === true
    && Array.isArray(runtime.boundaryChecks) && isDeepStrictEqual([...runtime.boundaryChecks].sort(), [...BOUNDARY_CHECKS])
    && Array.isArray(runtime.containers) && runtime.containers.length === SERVICES.length
    && isDeepStrictEqual(runtime.containers.map(row => row.service).sort(), [...SERVICES])
    && new Set(runtime.containers.map(row => row.containerId)).size === SERVICES.length
    && runtime.containers.every(row => closed(row, ["service", "containerId", "image"])
      && /^[a-f0-9]{12,64}$/u.test(row.containerId)
      && /^ghcr\.io\/princessdardan\/lash-her-platform-[a-z0-9-]+@sha256:[a-f0-9]{64}$/u.test(row.image)),
  "runtime-current");
  const provider = await dependencies.observeFrontendProvider();
  requireBoundary(closed(provider, ["configurationSha256", "cronsEnabled", "aliasJobActive", "deploymentId"])
    && provider.configurationSha256 === context.frontendConfigurationSha256 && provider.cronsEnabled === false
    && provider.aliasJobActive === false && /^dpl_[A-Za-z0-9]+$/u.test(provider.deploymentId), "frontend-provider-current");
  await frontend.verify(); host.verify();
  return Object.freeze({ version: 1, status: "P2_IDENTITY_ROTATION_BOUNDARY_VERIFIED", environment: "staging",
    actionId: context.actionId, phase: context.phase, bindingSha256: context.bindingSha256, sourceCommit: context.sourceCommit,
    candidateSha256: context.candidateSha256, runtimeConfigurationSha256: context.runtimeConfigurationSha256,
    frontendConfigurationSha256: context.frontendConfigurationSha256,
    frontendAdmission: structuredClone(physical.admission), containerCount: runtime.containers.length,
    deploymentId: provider.deploymentId, nativeSchedulesEnabled: false, businessSchedulesEnabled: false,
    sqlExecuted: false, rolesPrepared: false, loginChanged: false, trafficAuthorized: false });
}

export const P2_IDENTITY_ROTATION_SERVICES = SERVICES;
