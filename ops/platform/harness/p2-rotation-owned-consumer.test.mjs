import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bindP2CertificationReadyReceipts, P2_CERTIFICATION_READY_FILES, prepareP2BoundedCertification } from "../p2-certification.mjs";
import { withP2CertificationFrontendSession } from "../p2-certification-current-probe.mjs";
import { prepareP2CertificationRotationSuccessor } from "../p2-certification-rotation-successor.mjs";
import { p2CertificationEnvironmentLock } from "../p2-certification-transport.mjs";
import { frontendReleaseReceiptStore } from "../frontend-release-receipts.mjs";
import { p2NativeHash } from "../p2-lifecycle-native.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "../qualification-target-profile.mjs";

const base = { version: 2, qualificationTargetProfile: profile, environment: "staging" };
const raw = value => Buffer.from(JSON.stringify(value) + "\n");
const retain = (file, bytes) => writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
const encodeReady = records => Object.fromEntries(P2_CERTIFICATION_READY_FILES.map(name => [name, records.get(name).toString("base64")]));
const scopedAction = courseId => ({
  attemptId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", generation: 1, environmentId: "owned-mux-environment",
  uploadId: "owned-mux-upload", assetId: "owned-mux-asset", courseId,
  lessonId: "61111111-1111-4111-8111-111111111111", playbackIdSha256: p2NativeHash("owned-mux-playback"),
});

export function retainOwnedConsumerApiJobs(bundle, phase2ContractManifestSha256) {
  for (const path of ["jobs", "schema"]) mkdirSync(join(bundle, path), { mode: 0o700 });
  return Object.fromEntries(["course", "community"].map(name => {
    const service = `lash-her-${name}-api`;
    const schema = raw({ schemaVersion: 2, qualificationTargetProfile: profile, service, contractPhase: "p2",
      phase2ContractManifestSha256 });
    retain(join(bundle, "schema", name + ".json"), schema);
    const job = raw({ schemaVersion: 2, qualificationTargetProfile: profile, contractPhase: "p2", phase2ContractManifestSha256,
      schemaBaselineSha256: p2NativeHash(schema), target: { schemaVersion: 2, qualificationTargetProfile: profile,
        service, host: "127.0.0.1", port: 5432, database: `owned_${name}`, user: `owned_${name}_migration`,
        serverMajor: 18, artifactSha256: p2NativeHash(`owned-${name}-api-artifact`) } });
    retain(join(bundle, "jobs", name + ".json"), job);
    return [name, p2NativeHash(job)];
  }));
}

function prepareConsumer(loaded, dispatch, hostReview, rotation, privateInputs) {
  const { original, profiledRelease, candidateBytes } = loaded;
  retain(join(dispatch.directory, "host-rotation-joined.json"), rotation.terminalBytes);
  retain(join(dispatch.directory, "managed-rotation-successor-evidence.json"), raw(rotation.evidence));
  retain(join(dispatch.directory, "managed-rotation-frontend-ready.json"), raw(rotation.readyEvidence));
  const successor = rotation.successor, reviewed = hostReview.certificationPlan;
  const input = { ...base, operatorSourceCommit: hostReview.sourceCommit, certificationActionId: "p2-owned-mixed-successor-mux",
    mode: "mux-readiness", startState: "already-closed", initialEpoch: "7", candidateSha256: reviewed.candidateSha256,
    inventorySha256: reviewed.inventorySha256, configurationSha256: reviewed.configurationSha256,
    runtimeInventorySha256: successor.runtimeInventorySha256, gatewayProcessSha256: successor.gatewayProcessSha256,
    gatewayConfigurationSha256: successor.gatewayConfigurationSha256, operatorSourceClosureSha256: reviewed.operatorSourceClosureSha256,
    readyReceiptSha256: successor.frontend.readyReceiptSha256, scopedAction: scopedAction(dispatch.plan.courseId),
    native: { ...reviewed.nativePlan, deploymentId: successor.frontend.deploymentId, deploymentUrl: successor.frontend.deploymentUrl,
      configurationRecordSha256: successor.frontend.readyReceiptSha256["frontend-workload-outcome.json"] } };
  const localResults = dirname(dispatch.directory);
  const selection = { actionId: dispatch.plan.actionId, receiptSha256: rotation.evidence.receiptSha256 };
  assert.throws(() => prepareP2CertificationRotationSuccessor(selection, loaded, { ...input, initialEpoch: "6" },
    localResults, P2_CERTIFICATION_READY_FILES), { message: "P2_CERTIFICATION_ROTATION_SUCCESSOR_REFUSED" });
  const selected = prepareP2CertificationRotationSuccessor(selection, loaded, input, localResults, P2_CERTIFICATION_READY_FILES);
  const prepared = { migration: original.migration, plan: original.inventory };
  const plan = prepareP2BoundedCertification(prepared, input, candidateBytes, {
    frontendReceipts: selected.currentReady, configurationSha256: original.plan.configurationSha256,
    profiledRelease: { ...profiledRelease, rotationSuccessor: selected.binding,
      rotationSuccessorFrontendEpoch: successor.frontendEpoch, originalFrontendReady: selected.originalFrontendReady },
  });
  const originalNative = { ...plan.nativePlan, deploymentId: selected.originalFrontendReady.deploymentId,
    deploymentUrl: selected.originalFrontendReady.deploymentUrl,
    configurationRecordSha256: selected.originalFrontendReady.readyReceiptSha256["frontend-workload-outcome.json"] };
  bindP2CertificationReadyReceipts(selected.originalReady, {
    ...plan, candidate: original.migration.candidate, nativePlan: originalNative,
    readyReceiptSha256: selected.originalFrontendReady.readyReceiptSha256,
  });
  const packet = { ...hostReview, configuration: selected.configuration, certificationActionId: plan.certificationActionId,
    certificationPlan: plan, rotationSuccessorReceipt: selected.rawReceiptBase64,
    originalReadyReceipts: encodeReady(selected.originalReady), readyReceipts: encodeReady(selected.currentReady),
    confirmation: `staging/${plan.certificationActionId}`, credentials: privateInputs.credentials,
    vercelToken: privateInputs.vercelToken, scopedCronSecret: privateInputs.scopedCronSecret };
  assert.deepEqual(packet.originalReadyReceipts, hostReview.readyReceipts);
  assert.equal(packet.originalReleaseReceipt, loaded.originalReleaseReceipt.toString("base64"));
  assert.equal(plan.nativePlan.deploymentId, "dpl_OwnedCurrentOnly");
  assert.equal(plan.originalFrontendReady.deploymentId, "dpl_Owned");
  return { localResults, prepared, plan, packet };
}

export async function exerciseOwnedRotationConsumer({ loaded, dispatch, hostReview, rotation, privateInputs,
  postgres, sourceRoot, installed, priorProbe }) {
  const { localResults, prepared, plan, packet } = prepareConsumer(loaded, dispatch, hostReview, rotation, privateInputs);
  const directory = join(localResults, plan.certificationActionId);
  mkdirSync(directory, { mode: 0o700 });
  const receipts = frontendReleaseReceiptStore(directory);
  const diagnostics = [];
  let exited, proof, observed, joined;
  const transport = p2CertificationEnvironmentLock({ knownHosts: join(localResults, "fixture-known-hosts"),
    sshKey: join(localResults, "fixture-ssh-key") }, packet, directory, {
    expectedProfile: profile, launch(executable, args, options) {
      assert.equal(executable, "/usr/bin/ssh");
      assert.ok(args.at(-1).includes(join(installed, "ops/platform/host/p2_certification_parent.py")) &&
        args.at(-1).includes("--supervisor-profiled-current"));
      const child = spawn("/usr/bin/python3", ["-I", "-B", "-u", join(sourceRoot, "ops/platform/host/p2_rotation_owned_rehearsal_test.py"),
        "--consumer", installed], { ...options, env: { ...postgres.observerEnvironment(), P2_ROTATION_OWNED_NODE_SOURCE: sourceRoot } });
      child.on("exit", code => { exited = code; });
      child.stderr.on("data", bytes => {
        for (const code of bytes.toString().match(/(?:P2_|PROFILED_|QUALIFICATION_)[A-Z0-9_]{4,100}(?: [a-z0-9_]+\.py \d+)?/gu) ?? []) {
          if (diagnostics.length < 24 && !diagnostics.includes(code)) diagnostics.push(code);
        }
      });
      return child;
    },
  });
  const finalAdmission = { epoch: "7", newWork: false, recovery: false, active: 0, uncertain: 0 };
  let checkpoint = "host-lock", localError;
  const result = await transport(async (checkHost, signal, host) => {
    try {
      let preparedClose;
      const verifyEnvironment = async () => {
        assert.equal(signal.aborted, false);
        postgres.verifyEnvironment();
        await checkHost();
      };
      checkpoint = "frontend-lease";
      await withP2CertificationFrontendSession(prepared, plan, { getUrl: postgres.getUrl, verifyEnvironment }, async session => {
        try {
          checkpoint = "frontend-proof";
          const { receipt, probe } = session;
          proof = probe;
          assert.notEqual(probe.backendPid, priorProbe.backendPid);
          assert.notEqual(probe.marker, priorProbe.marker);
          assert.deepEqual(receipt.admission, finalAdmission);
          assert.equal(receipt.journalSha256, priorProbe.receipt.journalSha256);
          receipts.record("p2-certification-current-database.json", receipt);
          checkpoint = "host-arm";
          const current = await host.arm({ receipt, probe });
          checkpoint = "host-current-proof";
          assert.equal(current.status, "P2_CERTIFICATION_CURRENT_READY");
          assert.equal(current.runtimeReplaced, false);
          assert.equal(current.sqlReplayed, false);
          assert.equal(current.containers.length, 10);
          assert.equal(p2NativeHash(current.containers), rotation.successor.runtimeInventorySha256);
          assert.throws(() => execFileSync("/usr/bin/flock", ["-n", "/run/lock/lash-her-release.lock", "/usr/bin/true"]), { status: 1 });
          checkpoint = "scoped-read";
          observed = await host.scopedStage("scoped-mux-readiness-observe");
          checkpoint = "scoped-proof";
          assert.equal(observed.status, "P2_SCOPED_MUX_READY_OBSERVED");
          assert.equal(observed.planSha256, plan.planSha256);
          assert.equal(observed.frontendEpoch, "7");
          assert.deepEqual(observed.scopedAction, plan.scopedAction);
          assert.equal(observed.readOnly, true);
          const readyRow = { ...plan.scopedAction, status: "ready", isCurrent: true, managedByCourse: true };
          assert.equal(observed.readyRowSha256, p2NativeHash(JSON.stringify(readyRow, Object.keys(readyRow).sort()) + "\n"));
          for (const field of ["nativeEnabled", "muxProviderTouched", "trafficAuthorized", "releaseAccepted"]) assert.equal(observed[field], false);
          await session.verify();
          checkpoint = "host-close";
          preparedClose = await host.prepareClose(observed);
          checkpoint = "host-close-proof";
          assert.equal(preparedClose.status, "P2_PROFILED_CURRENT_CERTIFICATION_CONTAINED");
          assert.equal(preparedClose.planSha256, plan.planSha256);
          assert.equal(preparedClose.caseStatus, observed.status);
          receipts.record("p2-certification-close-prepared.json", preparedClose);
        } catch (error) { localError = error; throw error; }
      }, profile);
      checkpoint = "host-finish";
      joined = await host.finish(preparedClose);
      checkpoint = "host-commit";
      return joined;
    } catch (error) { localError ??= error; throw error; }
  }).catch(error => {
    throw new Error(`Owned successor consumer did not commit at ${checkpoint} (${diagnostics.join(", ")})`, { cause: localError ?? error });
  });
  assert.equal(exited, 0);
  assert.deepEqual(result, joined);
  assert.deepEqual(joined.rotationSuccessor, plan.rotationSuccessor);
  assert.deepEqual(joined.frontendAdmission, finalAdmission);
  assert.equal(joined.caseStatus, observed.status);
  for (const field of ["frontendSqlApplied", "sqlReplayed", "releaseAccepted"]) assert.equal(joined[field], false);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "p2-host-certification-outcome.json"))), joined);
  const hostAction = join(packet.results, `p2-profiled-current-certification-${plan.certificationActionId}`);
  const readHost = name => JSON.parse(readFileSync(join(hostAction, name)));
  assert.equal(existsSync(join(hostAction, "p2-independent-guard-outcome.json")), false);
  const hostTerminal = readFileSync(join(hostAction, "p2-profiled-current-certification-outcome.json"));
  assert.deepEqual(JSON.parse(hostTerminal), joined);
  assert.deepEqual(readHost("p2-scoped-case-joined.json"), observed);
  const guard = readHost("p2-mux-evidence-guard-verified.json");
  assert.equal(guard.status, "P2_MUX_EVIDENCE_GUARD_VERIFIED");
  assert.equal(guard.certificationActionId, plan.certificationActionId);
  assert.equal(guard.caseStatus, observed.status);
  assert.equal(guard.hostTerminalSha256, p2NativeHash(hostTerminal));
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "p2-host-certification-terminal-reference.json"))), {
    ...base, certificationActionId: plan.certificationActionId, planSha256: plan.planSha256,
    hostTerminalSha256: guard.hostTerminalSha256,
  });
  assert.deepEqual(Object.keys(joined.rotationFrontendObservationSha256).sort(), ["arm", "terminal"]);
  for (const stage of ["arm", "terminal"]) {
    const bytes = readFileSync(join(hostAction, `p2-rotation-successor-frontend-${stage}.json`));
    assert.equal(joined.rotationFrontendObservationSha256[stage], p2NativeHash(bytes));
    assert.equal(JSON.parse(bytes).deploymentId, plan.nativePlan.deploymentId);
  }
  execFileSync("/usr/bin/flock", ["-n", "/run/lock/lash-her-release.lock", "/usr/bin/true"]);
  const closed = await postgres.observeClosed(proof);
  assert.equal(closed.backendAbsent && closed.migrationLockReleased && closed.nonceLockReleased, true);
  assert.deepEqual(closed.admission, finalAdmission);
  assert.deepEqual(readHost("p2-certification-frontend-session-closed.json"), closed);
}
