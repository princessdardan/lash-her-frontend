import assert from "node:assert/strict";
import test from "node:test";
import { observeIdentityRotationBoundary, P2_IDENTITY_ROTATION_SERVICES } from "./p2-identity-key-rotation-observer.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

test("managed rotation observes the exact held replacement at each permitted closed epoch", async () => {
  const context = { version: 1, environment: "staging", actionId: "p2-key-rotation-owned", phase: "overlap",
    bindingSha256: "b".repeat(64), sourceCommit: "a".repeat(40), candidateSha256: "c".repeat(64),
    runtimeConfigurationSha256: "d".repeat(64), frontendConfigurationSha256: "e".repeat(64) };
  const qualification = { version: 2, qualificationTargetProfile: profile };
  const replacementRelease = { databaseOid: "44" };
  const admission = epoch => ({ epoch, newWork: false, recovery: false, active: 0, uncertain: 0 });
  const receipt = { ...qualification, status: "P2_CERTIFICATION_DATABASE_CURRENT", sourceCommit: context.sourceCommit,
    candidateSha256: context.candidateSha256, releaseId: "original", targetSha256: "1".repeat(64),
    planSha256: "2".repeat(64), journalSha256: "3".repeat(64), admission: admission("9"), replacementRelease };
  const probe = { ...qualification, marker: "4".repeat(64), backendPid: 123,
    backendStart: "2027-01-01T00:00:00.000000Z", receipt, replacementRelease,
    plan: { ...qualification, mode: "contain-native", certificationActionId: context.actionId,
      initialEpoch: "9", candidateSha256: context.candidateSha256, planSha256: receipt.planSha256 } };
  let epoch = "9", changeProof = value => value;
  context.frontendSession = { receipt, probe, verify: async () => {}, currentEpoch: () => epoch,
    observeCurrent: async () => changeProof({ ...qualification, status: "P2_FRONTEND_PHYSICAL_LOCK_VERIFIED",
      marker: probe.marker, backendPid: probe.backendPid, backendStart: probe.backendStart, environment: "staging",
      releaseId: receipt.releaseId, sourceCommit: context.sourceCommit, targetSha256: receipt.targetSha256,
      journalSha256: receipt.journalSha256, witnessSha256: "7".repeat(64), admission: admission(epoch), replacementRelease,
      effectiveLoginBoundaryVerified: true, predecessorRuntimeRoleAbsent: true }) };
  context.hostScope = { verify() {}, sourceCommit: context.sourceCommit, candidateSha256: context.candidateSha256,
    bindingSha256: context.bindingSha256 };
  const dependencies = { observePhysical: async () => { assert.fail("legacy observer selected"); },
    observeRuntime: async () => ({ configurationSha256: context.runtimeConfigurationSha256, nativeSchedulesEnabled: false,
      businessSchedulesEnabled: false, courseCurrent: true, communityCurrent: true,
      containers: P2_IDENTITY_ROTATION_SERVICES.map((service, index) => ({ service,
        containerId: (index + 1).toString(16).padStart(64, "0"),
        image: `ghcr.io/princessdardan/lash-her-platform-${service}@sha256:${"5".repeat(64)}` })),
      boundaryChecks: ["private-application-credential-required", "private-community-peer-denied", "private-course-tls-catalog",
        "public-metrics-hidden", "public-tls-missing-workload-denied"] }),
    observeFrontendProvider: async () => ({ configurationSha256: context.frontendConfigurationSha256, cronsEnabled: false,
      aliasJobActive: false, deploymentId: "dpl_Owned" }) };
  for (epoch of ["9", "11", "13", "15"]) {
    assert.equal((await observeIdentityRotationBoundary(context, dependencies)).frontendAdmission.epoch, epoch);
  }
  epoch = "16";
  await assert.rejects(observeIdentityRotationBoundary(context, dependencies), error => error.check === "managed-frontend-epoch");
  epoch = "15";
  for (const change of [{ backendPid: 456 }, { journalSha256: "6".repeat(64) }, { admission: admission("13") },
    { effectiveLoginBoundaryVerified: false }, { replacementRelease: { databaseOid: "55" } }]) {
    changeProof = value => ({ ...value, ...change });
    await assert.rejects(observeIdentityRotationBoundary(context, dependencies), error => error.check === "managed-frontend-physical-fence");
  }
});
