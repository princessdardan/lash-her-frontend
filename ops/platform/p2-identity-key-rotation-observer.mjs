import { isDeepStrictEqual } from "node:util";
import { observeRecoveryPhysical } from "./p2-recovery-current-probe.mjs";

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
  const physical = await (dependencies.observePhysical ?? observeRecoveryPhysical)(
    { ...frontend.probe, operation: "verify-schema" }, dependencies.physicalDependencies);
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
