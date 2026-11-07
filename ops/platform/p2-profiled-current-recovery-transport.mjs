// Fixed single-use transport for profiled current-only recovery. The caller
// retains the frontend database session while the supervised host retains the
// physical flock and independently observes that session.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sshCommand } from "./recreation_ssh.mjs";
import { readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { writeFrontendReceipt } from "./frontend-migration.mjs";
import { requireQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as current } from "./qualification-target-profile.mjs";
import { isDeepStrictEqual } from "node:util";

const MAXIMUM = 4_000_000;
const handles = new WeakMap();
const demand = value => { if (!value) throw new Error("P2_PROFILED_CURRENT_RECOVERY_TRANSPORT_REFUSED"); };
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);
const action = value => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const configurationNames = Object.freeze(["runtime.json", "gateway.json", "course-tls.json", "community-tls.json", "tls/ca.pem",
  "tls/gateway/ca.pem", "tls/gateway/key.pem", "tls/gateway/cert.pem", "tls/course/key.pem", "tls/course/cert.pem",
  "tls/community/key.pem", "tls/community/cert.pem", "course-api.env", "course-publisher.env", "course-snapshot.env",
  "community-api.env", "community-worker.env", "course-media.env", "course-export-cleanup.env"]);
const configuration = value => value && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...configurationNames].sort()) && Object.values(value).every(digest);
const originalReceiptNames = Object.freeze(["candidate", "frontendDatabase", "frontendContinuationStarted", "apiMigrationOutcome",
  "apiRuntimeOutcome", "frontendBuildOutcome", "frontendPromotionStarted", "frontendWorkloadOutcome"]);

function validateInitial(initial) {
  demand(initial?.version === 2 && initial.mode === "p2-profiled-current-recovery" && initial.environment === "staging"
    && /^[a-f0-9]{40}$/u.test(initial.sourceCommit ?? "") && !/^0+$/u.test(initial.sourceCommit)
    && action(initial.recoveryActionId) && action(initial.originalReleaseId) && initial.recoveryActionId !== initial.originalReleaseId
    && digest(initial.candidateSha256) && configuration(initial.configurationSha256) && digest(initial.targetSha256) && digest(initial.inventorySha256)
    && ["restore-current-runtime", "reconcile-frontend-get-first", "resume-approved-api-suffix"].includes(initial.disposition));
  requireQualificationTargetProfile(current, initial, initial.candidate, initial.frontendJob, initial.frontendJob?.target,
    initial.inventory);
  demand(initial.candidate.version === 3 && initial.candidate.environment === "staging"
    && initial.candidate.releaseId === initial.originalReleaseId
    && initial.candidate.sources?.frontend?.commit === initial.sourceCommit
    && initial.frontendJob?.version === 2 && initial.frontendJob.environment === "staging"
    && initial.frontendJob.releaseId === initial.originalReleaseId
    && initial.frontendJob.sourceCommit === initial.sourceCommit
    && initial.frontendJob.target?.approvedPendingTags?.length === 0
    && initial.frontendJob.target.allowEmptyBootstrap === false
    && initial.owner && Object.keys(initial.owner).sort().join(",") === "name,oid"
    && /^[a-z][a-z0-9_]{0,62}$/u.test(initial.owner.name ?? "") && /^[1-9][0-9]{0,9}$/u.test(initial.owner.oid ?? ""));
  demand(initial.originalReceiptSha256 && !Array.isArray(initial.originalReceiptSha256)
    && isDeepStrictEqual(Object.keys(initial.originalReceiptSha256), [...originalReceiptNames])
    && Object.values(initial.originalReceiptSha256).every(digest));
  const suffix = initial.approvedApiSuffix;
  if (initial.disposition === "resume-approved-api-suffix") {
    demand(suffix && !Array.isArray(suffix) && isDeepStrictEqual(Object.keys(suffix).sort(), ["community", "course"])
      && Object.values(suffix).every(value => Array.isArray(value)) && Object.values(suffix).flat().length > 0
      && Object.values(suffix).flat().every(tag => typeof tag === "string" && /^\d{4}_[a-z0-9_]+$/u.test(tag)));
  } else demand(suffix === undefined);
  return initial;
}

function retained(directory, name, value) {
  const bytes = readFrontendReleaseEvidence(directory, name);
  demand(bytes.length > 0 && bytes.length <= 2_000_000 && same(JSON.parse(bytes), value));
  return bytes;
}

export function p2ProfiledCurrentRecoveryEnvironmentLock(settings, initial, directory, { launch = spawn } = {}) {
  validateInitial(initial);
  const handle = Object.freeze({});
  handles.set(handle, async task => {
    demand(typeof task === "function");
    const remote = ["sudo", "-n", "/usr/bin/python3", "-I", "-u",
      `/opt/lash-her/operators/${initial.sourceCommit}/ops/platform/host/p2_release_supervisor.py`];
    const child = launch("/usr/bin/ssh", sshCommand({ knownHosts: settings.knownHosts, keyFile: settings.sshKey }, remote), {
      stdio: ["pipe", "pipe", "pipe"], env: Object.fromEntries(["PATH", "HOME", "LANG"]
        .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    });
    const lines = createInterface({ input: child.stdout });
    const pending = new Map();
    const signal = new AbortController();
    let sequence = 0, failed = false, active = true, exited, heartbeat, armed = false, priorGatewayPrepared = false;
    let apiReady = false, closePrepared = false, sessionClosed = false, joined, diagnostics = Buffer.alloc(0);
    const fail = () => {
      if (failed) return;
      failed = true; active = false; signal.abort();
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        for (const reject of waiter.rejects) reject(new Error("P2_PROFILED_CURRENT_RECOVERY_REMOTE_LOST"));
      }
      pending.clear(); child.stdin.end();
    };
    lines.on("line", raw => { try {
      demand(Buffer.byteLength(raw) <= MAXIMUM); const value = JSON.parse(raw), waiter = pending.get(value.id);
      demand(waiter && value.status === waiter.statuses[waiter.index]);
      if (value.status === "COMMITTED") { demand(joined && same(value.receipt, joined)); active = false; }
      const resolve = waiter.resolves[waiter.index++]; resolve(value);
      if (waiter.index === waiter.statuses.length) { pending.delete(value.id); clearTimeout(waiter.timer); }
    } catch { fail(); } });
    child.stderr.on("data", chunk => {
      if (diagnostics.length + chunk.length > 1_000_000) { fail(); return; }
      diagnostics = Buffer.concat([diagnostics, chunk]);
    });
    child.stderr.on("error", fail); child.on("error", fail); child.stdin.on("error", fail);
    child.on("exit", code => { exited = code; if (active || code !== 0) fail(); });
    const request = (operation, statuses, data = {}, timeout = 120_000) => {
      demand(active && !failed && Array.isArray(statuses) && statuses.length > 0);
      const id = ++sequence, raw = JSON.stringify({ id, operation, ...data }); demand(Buffer.byteLength(raw) <= MAXIMUM);
      const promises = statuses.map(() => { let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; });
      const timer = setTimeout(() => { fail(); }, timeout);
      pending.set(id, { statuses, index: 0, resolves: promises.map(value => value.resolve), rejects: promises.map(value => value.reject), timer });
      child.stdin.write(raw + "\n"); return promises.map(value => value.promise);
    };
    const single = async (operation, status, data = {}, timeout) => (await request(operation, [status], data, timeout)[0]).receipt;
    const locked = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { fail(); reject(new Error("P2_PROFILED_CURRENT_RECOVERY_REMOTE_UNCERTAIN")); }, 60_000);
      pending.set(0, { statuses: ["LOCKED"], index: 0, resolves: [value => { clearTimeout(timer); resolve(value); }], rejects: [reject], timer });
    });
    const rawInitial = JSON.stringify(initial); demand(Buffer.byteLength(rawInitial) <= MAXIMUM); child.stdin.write(rawInitial + "\n");
    let result, error;
    try {
      await locked;
      const check = async () => { await single("check", "HELD", {}, 15_000); };
      heartbeat = setInterval(() => { if (!failed) void check().catch(fail); }, 1_000);
      const host = Object.freeze({
        check,
        active: () => active && !failed && armed && !sessionClosed,
        async armRecovery({ receipt, continuationStarted, probe }) {
          demand(!armed && !priorGatewayPrepared && !apiReady && !closePrepared);
          const receiptBytes = retained(directory, "database-receipt.json", receipt);
          const continuationBytes = retained(directory, "frontend-continuation-started.json", continuationStarted);
          requireQualificationTargetProfile(current, receipt, continuationStarted, probe, probe.job, probe.job?.target);
          demand(receipt.version === 2 && receipt.status === "DATABASE_VERIFIED" && receipt.migrationMode === "verify-current-only"
            && receipt.readOnlyVerified === true && Array.isArray(receipt.applied) && receipt.applied.length === 0
            && probe.version === 2 && probe.operation === "verify-schema" && same(probe.receipt, receipt));
          const [armedResponse, readyResponse] = request("profiled-current-recovery-arm", ["PROFILED_CURRENT_RECOVERY_ARMED", "PROFILED_CURRENT_RECOVERY_API_READY"], {
            receipt: receiptBytes.toString("base64"), continuationStarted: continuationBytes.toString("base64"), probe,
          }, 900_000);
          await armedResponse; armed = true;
          return { apiReady: readyResponse.then(value => { apiReady = true;
            requireQualificationTargetProfile(current, value.receipt);
            demand(value.receipt?.status === "API_RUNTIME_READY" && value.receipt.environment === "staging"
              && value.receipt.releaseId === initial.originalReleaseId && value.receipt.trafficAuthorized === false);
            return value.receipt;
          }) };
        },
        async preparePriorGateway() {
          demand(armed && !priorGatewayPrepared && !apiReady && !closePrepared);
          const receipt = await single("profiled-current-recovery-prepare-prior-gateway", "PROFILED_CURRENT_RECOVERY_PRIOR_GATEWAY_PREPARED", {}, 300_000);
          demand(receipt?.status === "PRIOR_GATEWAY_CLOSED_ZERO"); priorGatewayPrepared = true; return receipt;
        },
        async reconcileFrontend(observation, proof, workload) {
          demand(armed && priorGatewayPrepared && apiReady && !closePrepared);
          requireQualificationTargetProfile(current, observation, proof);
          const originalPinsSha256 = hash(Buffer.from(JSON.stringify(Object.fromEntries(
            Object.entries(initial.originalReceiptSha256).sort(([left], [right]) => left.localeCompare(right))))));
          demand(observation.version === 2 && observation.status === "P2_PROFILED_CURRENT_FRONTEND_CURRENT"
            && observation.releaseId === initial.originalReleaseId && observation.sourceCommit === initial.sourceCommit
            && observation.getFirst === true && observation.newProviderPost === false && observation.ambiguous === false
            && observation.originalEffectReconciled === (initial.disposition === "reconcile-frontend-get-first")
            && observation.originalReceiptSha256 === originalPinsSha256
            && proof.version === 2 && proof.status === "P2_PROFILED_CURRENT_FRONTEND_VERIFIED"
            && proof.releaseId === initial.originalReleaseId && proof.sourceCommit === initial.sourceCommit
            && isDeepStrictEqual(observation.proof, proof)
            && Buffer.isBuffer(workload) && workload.length > 0 && workload.length <= 2_000_000
            && observation.workloadReceiptSha256 === hash(workload) && proof.workloadReceiptSha256 === hash(workload));
          const safeProof = Object.fromEntries(Object.entries(proof).filter(([key]) => !["evidence", "evidenceSha256"].includes(key)));
          const safeObservation = { ...Object.fromEntries(Object.entries(observation)
            .filter(([key]) => !["evidence", "evidenceSha256", "proof"].includes(key))), proof: safeProof };
          return single("profiled-current-recovery-reconcile-frontend", "PROFILED_CURRENT_RECOVERY_FRONTEND_RECONCILED",
            { observation: safeObservation, proof: safeProof, workload: workload.toString("base64") }, 300_000);
        },
        async resumeApprovedApiSuffix() {
          demand(armed && priorGatewayPrepared && apiReady && !closePrepared);
          return single("profiled-current-recovery-resume-api-suffix", "PROFILED_CURRENT_RECOVERY_API_SUFFIX_RESUMED", {}, 900_000);
        },
        async runtimeRestored() {
          demand(armed && priorGatewayPrepared && apiReady && !closePrepared);
          return single("profiled-current-recovery-runtime-restored", "PROFILED_CURRENT_RECOVERY_RUNTIME_RESTORED", {}, 600_000);
        },
        async prepareClose() {
          demand(armed && priorGatewayPrepared && apiReady && !closePrepared && !sessionClosed);
          const receipt = await single("profiled-current-recovery-prepare-close", "PROFILED_CURRENT_RECOVERY_CLOSE_PREPARED", {}, 120_000);
          closePrepared = true; return receipt;
        },
        async frontendSessionClosed() {
          demand(closePrepared && !sessionClosed);
          const receipt = await single("profiled-current-recovery-session-closed", "PROFILED_CURRENT_RECOVERY_SESSION_CLOSED", {}, 120_000);
          demand(receipt?.status === "P2_PROFILED_CURRENT_SESSION_CLOSED" && receipt.backendAbsent === true
            && receipt.migrationLockReleased === true && receipt.nonceLockReleased === true
            && receipt.admission?.newWork === false && receipt.admission.recovery === false
            && receipt.admission.active === 0 && receipt.admission.uncertain === 0);
          sessionClosed = true; return receipt;
        },
        async finish({ terminal, continuationCompleted, recoveryOutcome }) {
          demand(sessionClosed && !joined);
          const terminalBytes = retained(directory, "job-outcome.json", terminal);
          const continuationBytes = retained(directory, "frontend-continuation-completed.json", continuationCompleted);
          const recoveryBytes = retained(directory, "p2-profiled-current-recovery-held.json", recoveryOutcome);
          const receipt = await single("profiled-current-recovery-finish", "PROFILED_CURRENT_RECOVERY_JOINED", {
            terminal: terminalBytes.toString("base64"), continuationCompleted: continuationBytes.toString("base64"), recovery: recoveryBytes.toString("base64"),
          }, 120_000);
          demand(receipt?.status === "P2_PROFILED_CURRENT_RECOVERED_FENCED"); joined = receipt; return receipt;
        },
      });
      await check(); result = await task(check, signal.signal, host); await check(); demand(joined && sessionClosed && !failed);
      const committed = await single("commit", "COMMITTED", {}, 120_000); demand(!active && same(committed, joined));
      writeFrontendReceipt(directory, "p2-profiled-current-recovery-host-outcome.json", committed); active = false;
    } catch { error = new Error("P2_PROFILED_CURRENT_RECOVERY_FAILED_REQUIRES_REVIEW"); fail(); }
    finally {
      clearInterval(heartbeat); child.stdin.end();
      if (exited === undefined) await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill("SIGTERM"); error ??= new Error("P2_PROFILED_CURRENT_RECOVERY_HOST_CLEANUP_UNCERTAIN"); resolve(); }, 60_000);
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
      active = false; lines.close(); for (const waiter of pending.values()) clearTimeout(waiter.timer);
      if (exited !== 0) error ??= new Error("P2_PROFILED_CURRENT_RECOVERY_HOST_CLEANUP_UNCERTAIN");
      if (error && diagnostics.length) writeFileSync(join(directory, "p2-profiled-current-recovery-private-stderr.bin"), diagnostics, { mode: 0o600, flag: "wx" });
    }
    if (error) throw error; return result;
  });
  return handle;
}

export async function withP2ProfiledCurrentRecoveryTransport(handle, task) {
  const factory = handles.get(handle); demand(factory && typeof task === "function"); handles.delete(handle); return factory(task);
}

export const P2_PROFILED_CURRENT_RECOVERY_TRANSPORT = Object.freeze({
  fixedHostEntry: "ops/platform/host/p2_release_supervisor.py", mode: "p2-profiled-current-recovery", reusable: false,
  outcomeSha256: value => hash(Buffer.from(JSON.stringify(value))),
});
