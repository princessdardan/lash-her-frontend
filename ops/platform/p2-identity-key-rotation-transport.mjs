// Fixed single-use SSH transport for the config-only identity rotation.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { sshCommand } from "./recreation_ssh.mjs";
import { isDeepStrictEqual } from "node:util";
import { requireQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";
import { isReviewedManagedIdentityRotationTransport } from "./p2-identity-key-rotation-operator.mjs";

const handles = new WeakMap();
const heldManagedHosts = new WeakMap();
const MAXIMUM = 4_000_000;
// The fixed Vercel build and promotion observers alone allow 900s and 180s.
const FRONTEND_ROLLOUT_TIMEOUT_MS = 1_320_000;
const demand = value => { if (!value) throw new Error("P2_IDENTITY_ROTATION_TRANSPORT_REFUSED"); };
const captureProfiles = ["community-admin", "community-member", "course-admin", "course-learner"];
const captureFields = "profile,status,tokenExpiresAt,tokenIssuedAt";

function captureTime(value) {
  demand(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u.test(value));
  const time = Date.parse(value);
  demand(Number.isFinite(time) && new Date(time).toISOString() === value);
  return time;
}

export function requireP2IdentityRotationCaptureMetadata(value) {
  demand(Array.isArray(value) && value.length === captureProfiles.length && value.every((row, index) =>
    row && Object.getPrototypeOf(row) === Object.prototype && Object.keys(row).sort().join() === captureFields
    && row.profile === captureProfiles[index] && row.status === "P2_IDENTITY_ROTATION_PRIVATE_TOKENS_CAPTURED"
    && captureTime(row.tokenExpiresAt) - captureTime(row.tokenIssuedAt) === 300_000));
  return value;
}

export function isHeldManagedIdentityRotationHost(host, frontendPlan, { armed = false, fixture = false } = {}) {
  const held = heldManagedHosts.get(host);
  return Boolean(held && held.fixture === fixture && held.active(armed) && held.plan.frontendCustodyPlanSha256 === frontendPlan?.planSha256 &&
    held.plan.actionId === frontendPlan.certificationActionId && held.plan.sourceCommit === frontendPlan.sourceCommit &&
    held.plan.candidateSha256 === frontendPlan.candidateSha256 && held.plan.targetSha256 === frontendPlan.targetSha256);
}

export function claimManagedIdentityRotationWriterTransition(host, frontendPlan, operation, epoch, { fixture = false } = {}) {
  return isHeldManagedIdentityRotationHost(host, frontendPlan, { armed: true, fixture }) &&
    heldManagedHosts.get(host).claimWriterTransition(operation, epoch);
}

const managedSharedFields = ["qualificationTargetProfile", "environment", "sourceCommit", "sourceSha256", "sourceClosureSha256",
  "hostMachineId", "bundle", "configuration", "results", "candidate", "candidateSha256", "configurationSha256"];
const managedFields = ["version", "mode", ...managedSharedFields, "rotationActionId", "rotationPlan", "frontendCustody", "confirmation",
  "credentials", "vercelToken", "scopedCronSecret", "nativePlan", "baselineConfigurationRecordSha256", "rotationConfiguration",
  "privateRotationConfigurationSha256", "expectedFeatureControls", "expectedWriterAdmissionBinding", "operatorProgramSha256",
  "rotationBrowserProgramSha256", "gatewayHost", "certification", "targetSha256", "owner", "producers"];

export function p2IdentityRotationEnvironmentLock(settings, initial, options = {}) {
  const plan = initial?.rotationPlan, managed = plan?.version === 2;
  const fixture = options.fixture === true;
  demand(Object.keys(options).sort().join() === (fixture ? "fixture,openOwnedChannel" : "") &&
    (!fixture || managed && typeof options.openOwnedChannel === "function") &&
    initial?.mode === "p2-identity-key-rotation" && initial.environment === "staging"
    && (managed ? initial.version === 2 : plan?.version === 1)
    && plan.environment === "staging" && plan.actionId === initial.rotationActionId
    && plan.sourceCommit === initial.sourceCommit && plan.candidateSha256 === initial.candidateSha256
    && /^[a-f0-9]{40}$/u.test(initial.sourceCommit ?? ""));
  if (managed) {
    const { frontendCustody } = initial;
    requireQualificationTargetProfile(profile, initial, plan, frontendCustody, frontendCustody?.certificationPlan);
    demand(isDeepStrictEqual(Object.keys(initial).sort(), [...managedFields].sort()) &&
      managedSharedFields.every(key => isDeepStrictEqual(initial[key], frontendCustody[key])) &&
      frontendCustody.certificationActionId === plan.actionId &&
      frontendCustody.certificationPlan.planSha256 === plan.frontendCustodyPlanSha256 &&
      isDeepStrictEqual(frontendCustody.certificationPlan.nativePlan, initial.nativePlan) &&
      plan.finalEpoch === (BigInt(plan.initialEpoch) + 6n).toString());
  }
  const packet = JSON.stringify(initial);
  demand(Buffer.byteLength(packet) <= MAXIMUM);
  const openOwnedChannel = options.openOwnedChannel;
  const handle = Object.freeze({});
  const run = async (selectedPlan, task) => {
    demand(selectedPlan === plan && typeof task === "function");
    if (!fixture && (managed ? !P2_IDENTITY_ROTATION_TRANSPORT.managedLiveEligible ||
      !isReviewedManagedIdentityRotationTransport(handle) : !P2_IDENTITY_ROTATION_TRANSPORT.liveEligible)) {
      throw new Error("P2_IDENTITY_ROTATION_LIVE_EXECUTION_UNQUALIFIED");
    }
    const command = ["sudo", "-n", "/usr/bin/python3", "-I", "-u",
      `/opt/lash-her/operators/${initial.sourceCommit}/ops/platform/host/p2_identity_key_rotation_parent.py`, "--supervisor"];
    const child = fixture ? openOwnedChannel() :
      spawn("/usr/bin/ssh", sshCommand({ knownHosts: settings.knownHosts, keyFile: settings.sshKey }, command),
      { stdio: ["pipe", "pipe", "pipe"], env: Object.fromEntries(["PATH", "HOME", "LANG"]
        .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) });
    const lines = createInterface({ input: child.stdout });
    const pending = new Map(); let sequence = 0, failed = false, active = true, exited, joined = null, heartbeat;
    const fail = () => { if (failed) return; failed = true; active = false; for (const waiter of pending.values()) {
      clearTimeout(waiter.timer); waiter.reject(new Error("P2_IDENTITY_ROTATION_REMOTE_LOST"));
    } pending.clear(); child.stdin.end(); };
    lines.on("line", raw => { try {
      demand(Buffer.byteLength(raw) <= MAXIMUM); const value = JSON.parse(raw), waiter = pending.get(value.id);
      demand(waiter && value.status === waiter.status);
      if (value.status === "ROTATION_CAPTURED") {
        demand(Object.keys(value).sort().join() === "id,receipt,status");
        requireP2IdentityRotationCaptureMetadata(value.receipt);
      }
      pending.delete(value.id); clearTimeout(waiter.timer); waiter.resolve(value);
    } catch { fail(); } });
    child.stderr.resume(); child.on("error", fail); child.stdin.on("error", fail);
    child.on("exit", code => { exited = code; if (active || code !== 0) fail(); });
    const expect = (id, status, timeout) => new Promise((resolve, reject) => {
      demand(!failed && !pending.has(id)); const timer = setTimeout(() => { fail(); reject(new Error("P2_IDENTITY_ROTATION_REMOTE_UNCERTAIN")); }, timeout);
      pending.set(id, { status, resolve, reject, timer });
    });
    const request = (operation, status, data = {}, timeout = 120_000) => {
      demand(active && !failed); const id = ++sequence, raw = JSON.stringify({ id, operation, ...data }); demand(Buffer.byteLength(raw) <= MAXIMUM);
      const response = expect(id, status, timeout); child.stdin.write(raw + "\n"); return response;
    };
    const ready = expect(0, "LOCKED", 60_000);
    child.stdin.write(packet + "\n");
    let result, error;
    try {
      await ready; const check = async () => { await request("check", "HELD", {}, 15_000); };
      heartbeat = setInterval(() => { if (!failed) void check().catch(fail); }, 1_000);
      let armed = false, closePrepared = false, finished = false;
      let writerTransition;
      const call = async (operation, status, data = {}, timeout) => (await request(operation, status, data, timeout)).receipt;
      const retainWriterTransition = (operation, window, acknowledgement) => {
        if (!managed || window.kind !== "authentication") return;
        const reviewed = plan.authenticationWindows.find(row => row.phase === window.phase);
        demand(reviewed && !writerTransition && window.bindingSha256 === plan.bindingSha256 &&
          acknowledgement.bindingSha256 === plan.bindingSha256 && acknowledgement.phase === window.phase &&
          acknowledgement.kind === window.kind);
        const epoch = operation === "open" ? reviewed.beforeEpoch : reviewed.openEpoch;
        demand(operation === "open"
          ? acknowledgement.status === "P2_IDENTITY_ROTATION_BROWSER_WINDOW_INTENT" &&
            acknowledgement.beforeEpoch === epoch && acknowledgement.expectedOpenEpoch === reviewed.openEpoch
          : acknowledgement.status === "P2_IDENTITY_ROTATION_BROWSER_WINDOW_CLOSING" &&
            window.epoch === epoch && acknowledgement.epoch === epoch);
        writerTransition = { operation, epoch };
      };
      const host = Object.freeze({
        active: () => active && !failed && armed && !finished,
        check,
        async arm({ receipt, probe }) {
          demand(!armed && !finished);
          const value = await call("rotation-arm", "ROTATION_ARMED",
            { receipt: Buffer.from(JSON.stringify(receipt)).toString("base64"), probe }, 240_000);
          if (managed) {
            requireQualificationTargetProfile(profile, value);
            demand(value?.status === "P2_IDENTITY_ROTATION_PARENT_ARMED" && value.version === 2 &&
              value.trafficAuthorized === false && ["actionId", "bindingSha256", "sourceCommit", "candidateSha256"]
                .every(key => value[key] === plan[key]));
          }
          armed = true;
          return value;
        },
        observeRuntime: () => call("rotation-observe-runtime", "ROTATION_OBSERVED"),
        observeFrontendProvider: () => call("rotation-observe-frontend", "ROTATION_OBSERVED"),
        applyMutation: intent => call("rotation-apply-mutation", "ROTATION_MUTATION", { intent },
          intent.kind === "frontend" ? FRONTEND_ROLLOUT_TIMEOUT_MS : 300_000),
        reconcileMutation: intent => call("rotation-reconcile-mutation", "ROTATION_MUTATION", { intent }, 240_000),
        captureTokens: () => call("rotation-capture", "ROTATION_CAPTURED"),
        observeProfiles: phase => call("rotation-observe-profiles", "ROTATION_PROFILES_OBSERVED", { phase }, 120_000),
        observeFrontendSigner: phase => call("rotation-observe-signer", "ROTATION_SIGNER_OBSERVED", { phase }),
        frontendDeployment: phase => call("rotation-frontend-deployment", "ROTATION_FRONTEND_DEPLOYMENT", { phase }),
        observeCanonicalOrigin: phase => call("rotation-observe-canonical-origin", "ROTATION_CANONICAL_ORIGIN", { phase }, 120_000),
        async beginBrowserWindow(window) {
          const acknowledgement = await call("rotation-browser-window-begin", "ROTATION_BROWSER_WINDOW_INTENT", { window });
          retainWriterTransition("open", window, acknowledgement);
          return acknowledgement;
        },
        browserWindowOpened: window => call("rotation-browser-window-opened", "ROTATION_BROWSER_WINDOW_OPENED", { window }),
        takeBrowserPermit: window => call("rotation-browser-window-permit", "ROTATION_BROWSER_WINDOW_PRIVATE_PERMIT", { window }),
        async closingBrowserWindow(window) {
          const acknowledgement = await call("rotation-browser-window-closing", "ROTATION_BROWSER_WINDOW_CLOSING", { window });
          retainWriterTransition("close", window, acknowledgement);
          return acknowledgement;
        },
        endBrowserWindow: window => call("rotation-browser-window-end", "ROTATION_BROWSER_WINDOW_CLOSED", { window }, 300_000),
        retainFrontendSigner: (phase, record) => call("rotation-retain-signer", "ROTATION_SIGNER_RETAINED", { phase, record }),
        failClosed: state => call("rotation-fail-closed", "ROTATION_CONTAINED", { state }, 120_000),
        restoreQualified: (phase, configuration) => call("rotation-restore", "ROTATION_RESTORED", { phase, configuration },
          FRONTEND_ROLLOUT_TIMEOUT_MS + 300_000),
        async finish(outcome) { demand(armed && !closePrepared && !finished); const value = await call("rotation-prepare-close", "ROTATION_CLOSE_PREPARED", { outcome }); closePrepared = true; return value; },
        async frontendSessionClosed(frontendSessionClosed) {
          demand(armed && closePrepared && !finished);
          if (managed) {
            requireQualificationTargetProfile(profile, frontendSessionClosed);
            demand(frontendSessionClosed.version === 2 && frontendSessionClosed.status === "P2_CERTIFICATION_FRONTEND_SESSION_CLOSED" &&
              frontendSessionClosed.admission?.epoch === plan.finalEpoch && frontendSessionClosed.backendAbsent === true &&
              frontendSessionClosed.migrationLockReleased === true && frontendSessionClosed.nonceLockReleased === true);
          } else demand(frontendSessionClosed === undefined);
          joined = await call("rotation-session-closed", "ROTATION_JOINED", managed ? { frontendSessionClosed } : {}, 120_000);
          finished = true;
          return joined;
        },
      });
      await check();
      if (managed) {
        heldManagedHosts.set(host, {
          plan, fixture, active: needsArm => active && !failed && !closePrepared && !finished && (!needsArm || armed),
          claimWriterTransition(operation, epoch) {
            if (!writerTransition || writerTransition.operation !== operation || writerTransition.epoch !== epoch) return false;
            writerTransition = undefined;
            return true;
          },
        });
      }
      try { result = await task(host); }
      finally { heldManagedHosts.delete(host); }
      demand(finished && joined && !failed);
      const committed = await request("commit", "COMMITTED", {}, 120_000); demand(JSON.stringify(committed.receipt) === JSON.stringify(joined));
      active = false;
    } catch (cause) {
      error = new Error("P2_IDENTITY_ROTATION_FAILED_REQUIRES_REVIEW", fixture ? { cause } : undefined);
      fail();
    }
    finally {
      clearInterval(heartbeat); child.stdin.end();
      if (exited === undefined) await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill("SIGTERM"); error ??= new Error("P2_IDENTITY_ROTATION_HOST_CLEANUP_UNCERTAIN"); resolve(); }, 60_000);
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
      active = false; lines.close(); for (const waiter of pending.values()) clearTimeout(waiter.timer);
      if (exited !== 0) error ??= new Error("P2_IDENTITY_ROTATION_HOST_CLEANUP_UNCERTAIN");
    }
    if (error) throw error; return result;
  };
  handles.set(handle, { fixture, run });
  return handle;
}

export async function withP2IdentityRotationTransport(handle, plan, task, { fixture = false } = {}) {
  const factory = handles.get(handle);
  demand(factory && factory.fixture === fixture && typeof task === "function");
  handles.delete(handle);
  return factory.run(plan, task);
}

export const P2_IDENTITY_ROTATION_TRANSPORT = Object.freeze({ sharedSupervisorLayoutIntegrated: true, liveEligible: false,
  managedLiveEligible: false,
  fixedHostEntry: "ops/platform/host/p2_identity_key_rotation_parent.py", reusable: false });
