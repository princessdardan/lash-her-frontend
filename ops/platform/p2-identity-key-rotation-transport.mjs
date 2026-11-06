// Fixed single-use SSH transport for the config-only identity rotation.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { sshCommand } from "./recreation_ssh.mjs";

const handles = new WeakMap();
const MAXIMUM = 4_000_000;
const demand = value => { if (!value) throw new Error("P2_IDENTITY_ROTATION_TRANSPORT_REFUSED"); };

export function p2IdentityRotationEnvironmentLock(settings, initial) {
  const plan = initial?.rotationPlan;
  demand(initial?.mode === "p2-identity-key-rotation" && initial.environment === "staging"
    && plan?.version === 1 && plan.environment === "staging" && plan.actionId === initial.rotationActionId
    && plan.sourceCommit === initial.sourceCommit && plan.candidateSha256 === initial.candidateSha256
    && /^[a-f0-9]{40}$/u.test(initial.sourceCommit ?? ""));
  const handle = Object.freeze({});
  handles.set(handle, async (selectedPlan, task) => {
    demand(selectedPlan === plan && typeof task === "function");
    const command = ["sudo", "-n", "/usr/bin/python3", "-I", "-u",
      `/opt/lash-her/operators/${initial.sourceCommit}/ops/platform/host/p2_identity_key_rotation_parent.py`, "--supervisor"];
    const child = spawn("/usr/bin/ssh", sshCommand({ knownHosts: settings.knownHosts, keyFile: settings.sshKey }, command),
      { stdio: ["pipe", "pipe", "pipe"], env: Object.fromEntries(["PATH", "HOME", "LANG"]
        .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) });
    const lines = createInterface({ input: child.stdout });
    const pending = new Map(); let sequence = 0, failed = false, active = true, exited, joined = null, heartbeat;
    const fail = () => { if (failed) return; failed = true; active = false; for (const waiter of pending.values()) {
      clearTimeout(waiter.timer); waiter.reject(new Error("P2_IDENTITY_ROTATION_REMOTE_LOST"));
    } pending.clear(); child.stdin.end(); };
    lines.on("line", raw => { try {
      demand(Buffer.byteLength(raw) <= MAXIMUM); const value = JSON.parse(raw), waiter = pending.get(value.id);
      demand(waiter && value.status === waiter.status); pending.delete(value.id); clearTimeout(waiter.timer); waiter.resolve(value);
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
    const ready = expect(0, "LOCKED", 60_000), raw = JSON.stringify(initial); demand(Buffer.byteLength(raw) <= MAXIMUM);
    child.stdin.write(raw + "\n");
    let result, error;
    try {
      await ready; const check = async () => { await request("check", "HELD", {}, 15_000); };
      heartbeat = setInterval(() => { if (!failed) void check().catch(fail); }, 1_000);
      let armed = false, finished = false;
      const call = async (operation, status, data = {}, timeout) => (await request(operation, status, data, timeout)).receipt;
      const host = Object.freeze({
        active: () => active && !failed && armed && !finished,
        check,
        async arm({ receipt, probe }) { demand(!armed && !finished); const value = await call("rotation-arm", "ROTATION_ARMED",
          { receipt: Buffer.from(JSON.stringify(receipt)).toString("base64"), probe }, 240_000); armed = true; return value; },
        observeRuntime: () => call("rotation-observe-runtime", "ROTATION_OBSERVED"),
        observeFrontendProvider: () => call("rotation-observe-frontend", "ROTATION_OBSERVED"),
        applyMutation: intent => call("rotation-apply-mutation", "ROTATION_MUTATION", { intent }, 300_000),
        reconcileMutation: intent => call("rotation-reconcile-mutation", "ROTATION_MUTATION", { intent }, 240_000),
        captureTokens: () => call("rotation-capture", "ROTATION_CAPTURED"),
        observeProfiles: phase => call("rotation-observe-profiles", "ROTATION_PROFILES_OBSERVED", { phase }, 120_000),
        observeFrontendSigner: phase => call("rotation-observe-signer", "ROTATION_SIGNER_OBSERVED", { phase }),
        frontendDeployment: phase => call("rotation-frontend-deployment", "ROTATION_FRONTEND_DEPLOYMENT", { phase }),
        beginBrowserWindow: window => call("rotation-browser-window-begin", "ROTATION_BROWSER_WINDOW_INTENT", { window }),
        browserWindowOpened: window => call("rotation-browser-window-opened", "ROTATION_BROWSER_WINDOW_OPENED", { window }),
        closingBrowserWindow: window => call("rotation-browser-window-closing", "ROTATION_BROWSER_WINDOW_CLOSING", { window }),
        endBrowserWindow: window => call("rotation-browser-window-end", "ROTATION_BROWSER_WINDOW_CLOSED", { window }, 300_000),
        retainFrontendSigner: (phase, record) => call("rotation-retain-signer", "ROTATION_SIGNER_RETAINED", { phase, record }),
        failClosed: state => call("rotation-fail-closed", "ROTATION_CONTAINED", { state }, 120_000),
        restoreQualified: (phase, configuration) => call("rotation-restore", "ROTATION_RESTORED", { phase, configuration }, 300_000),
        async finish(outcome) { demand(armed && !finished); joined = await call("rotation-finish", "ROTATION_JOINED", { outcome }); finished = true; return joined; },
      });
      await check(); result = await task(host); demand(finished && joined && !failed);
      const committed = await request("commit", "COMMITTED", {}, 120_000); demand(JSON.stringify(committed.receipt) === JSON.stringify(joined));
      active = false;
    } catch { error = new Error("P2_IDENTITY_ROTATION_FAILED_REQUIRES_REVIEW"); fail(); }
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
  });
  return handle;
}

export async function withP2IdentityRotationTransport(handle, plan, task) {
  const factory = handles.get(handle); demand(factory && typeof task === "function"); handles.delete(handle); return factory(plan, task);
}

export const P2_IDENTITY_ROTATION_TRANSPORT = Object.freeze({ sharedSupervisorLayoutIntegrated: false,
  fixedHostEntry: "ops/platform/host/p2_identity_key_rotation_parent.py", reusable: false });
