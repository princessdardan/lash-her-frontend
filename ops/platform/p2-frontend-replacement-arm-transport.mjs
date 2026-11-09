import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { sshCommand } from "./recreation_ssh.mjs";
import { decodeQualificationTargetJson } from "./qualification-target-profile.mjs";

const maximum = 4_000_000;
const refusal = "P2_FRONTEND_REPLACEMENT_HOST_ARM_REFUSED";
const demand = ok => { if (!ok) throw new Error(refusal); };
const digest = value => typeof value === "string" && /^(?!0+$)[a-f0-9]{64}$/u.test(value);
const fields = (value, names) => value && isDeepStrictEqual(Object.keys(value).sort(), [...names].sort());
const unavailable = () => new Error(refusal);

function receiptBinding(initial, plan, status) {
  return {
    version: 1, qualificationTargetProfile: initial.qualificationTargetProfile, status, environment: "staging",
    releaseId: plan.releaseId, sourceCommit: initial.sourceCommit, candidateSha256: initial.candidateSha256,
    targetSha256: plan.targetSha256, reviewedPlanSha256: initial.reviewedPlanSha256,
    bootstrapAuthorized: false, migrationAuthorized: false, deploymentAuthorized: false, trafficAuthorized: false,
  };
}

export async function exchangeFrontendReplacementArm(child, initial, plan, task) {
  const controller = new AbortController();
  let pending, failure, force, output = Buffer.alloc(0), stderrBytes = 0, sequence = 0, committed = false, closed = false;
  const fail = () => {
    if (failure) return;
    failure = unavailable();
    controller.abort();
    pending?.reject(failure);
    child.stdin.destroy();
    if (!closed) {
      child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), 5000);
    }
  };
  const reaped = new Promise(resolve => child.once("close", (code, signal) => {
    closed = true;
    clearTimeout(force);
    if (!committed || code !== 0 || signal || output.length) fail();
    resolve({ code, signal });
  }));
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stdout.on("error", fail);
  child.stderr.on("error", fail);
  child.stderr.on("data", chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > 64_000) fail();
  });
  child.stdout.on("data", chunk => {
    if (failure) return;
    if (output.length + chunk.length > maximum) { fail(); return; }
    output = Buffer.concat([output, chunk]);
    const newline = output.indexOf(10);
    if (newline < 0) return;
    try {
      demand(pending && newline > 0 && newline === output.length - 1);
      const value = decodeQualificationTargetJson(output.subarray(0, newline), "private-packet");
      output = Buffer.alloc(0);
      demand(value.id === pending.id && value.status === pending.status);
      const complete = pending.resolve;
      pending = undefined;
      complete(value);
    } catch { fail(); }
  });
  const exchange = (id, status, packet) => {
    demand(!failure && !pending && !committed);
    const raw = Buffer.from(JSON.stringify(packet) + "\n");
    demand(raw.length <= maximum);
    return new Promise((resolve, reject) => {
      pending = { id, status, resolve, reject };
      child.stdin.write(raw, error => { if (error) fail(); });
    });
  };
  const timer = setTimeout(fail, 120_000);
  let armed;
  try {
    demand(fields(await exchange(0, "LOCKED", initial), ["id", "status"]));
    const verifyEnvironment = async () => {
      const id = ++sequence;
      demand(fields(await exchange(id, "LOCKED", { id, operation: "check" }), ["id", "status"]));
    };
    const arm = async probe => {
      demand(!armed);
      const id = ++sequence;
      const reply = await exchange(id, "REPLACEMENT_ARMED", { id, operation: "arm-replacement", probe });
      demand(fields(reply, ["id", "status", "receipt", "armReceiptSha256"]) && digest(reply.armReceiptSha256));
      const { physicalObservation, physicalObservationSha256, ...binding } = reply.receipt;
      demand(isDeepStrictEqual(binding, receiptBinding(initial, plan, "P2_FRONTEND_REPLACEMENT_ARMED")) &&
        typeof physicalObservation === "string" && physicalObservation.length <= 10_924 && digest(physicalObservationSha256));
      armed = reply;
      return { physicalObservation, physicalObservationSha256, armReceiptSha256: reply.armReceiptSha256 };
    };
    const result = await task({ verifyEnvironment, arm, signal: controller.signal });
    demand(armed && !failure);
    const id = ++sequence;
    const terminal = await exchange(id, "COMMITTED", { id, operation: "commit" });
    demand(fields(terminal, ["id", "status", "receipt"]) && isDeepStrictEqual(terminal.receipt, {
      ...receiptBinding(initial, plan, "P2_FRONTEND_REPLACEMENT_ARM_COMMITTED"),
      armReceiptSha256: armed.armReceiptSha256, physicalObservationSha256: armed.receipt.physicalObservationSha256,
      backendClosureVerified: false,
    }));
    committed = true;
    child.stdin.end();
    const exit = await reaped;
    demand(!failure && exit.code === 0 && !exit.signal);
    return { result, receipt: terminal.receipt };
  } catch {
    fail();
    await reaped;
    throw unavailable();
  } finally { clearTimeout(timer); }
}

export function withFrontendReplacementHost(settings, initial, plan, task) {
  const remote = ["sudo", "-n", "/usr/bin/python3", "-I", "-u",
    `/opt/lash-her/operators/${initial.sourceCommit}/ops/platform/host/p2_frontend_replacement_parent.py`,
    "--supervise-pre-bootstrap"];
  demand(/^(?!0+$)[a-f0-9]{40}$/u.test(initial.sourceCommit));
  const child = spawn("/usr/bin/ssh", sshCommand({ knownHosts: settings.knownHosts, keyFile: settings.sshKey }, remote), {
    stdio: ["pipe", "pipe", "pipe"],
    env: Object.fromEntries(["PATH", "HOME", "LANG"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
  });
  return exchangeFrontendReplacementArm(child, initial, plan, task);
}
