// Plan by default. Executable target is the one fixed installed host program.
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sshCommand } from "./recreation_ssh.mjs";
import { prepareP2LifecycleReceiverPlan, validateReceiverNegativeOutcome } from "./p2-lifecycle-receiver-negatives.mjs";

const demand = condition => { if (!condition) throw new Error("P2_LIFECYCLE_RECEIVER_ACTION_REFUSED"); };
function privatePath(path, modes) {
  demand(isAbsolute(path) && realpathSync(path) === path);
  const info = lstatSync(path);
  demand(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && modes.includes(info.mode & 0o777));
  for (let parent = dirname(path);; parent = dirname(parent)) {
    try { lstatSync(join(parent, ".git")); throw new Error("PRIVATE_FILE_IN_GIT"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (dirname(parent) === parent) break;
  }
}
export async function executeP2LifecycleReceiverAction(settings, privateInput, confirmation) {
  demand(process.versions.node.split(".")[0] === "24" && settings && typeof settings === "object"
    && Object.keys(settings).sort().join() === ["version", "environment", "knownHosts", "sshKey", "bundleDirectory", "configurationDirectory", "reviewed"].sort().join()
    && settings.version === 1 && settings.environment === "staging");
  const plan = prepareP2LifecycleReceiverPlan(settings.reviewed);
  demand(confirmation === "staging/" + plan.actionId);
  privatePath(settings.knownHosts, [0o600, 0o644]); privatePath(settings.sshKey, [0o400]);
  const commit = settings.reviewed.persistence.plan.sources.frontend;
  const remote = ["sudo", "-n", "/usr/bin/python3", "-I", "-u", `/opt/lash-her/operators/${commit}/ops/platform/host/p2_lifecycle_receiver_negative.py`];
  const raw = Buffer.from(JSON.stringify({ version: 1, operation: "execute-account-state-preserving", bundleDirectory: settings.bundleDirectory,
    configurationDirectory: settings.configurationDirectory, reviewed: settings.reviewed, confirmation, private: privateInput }));
  demand(raw.length <= 262144);
  const child = spawn("/usr/bin/ssh", sshCommand({ knownHosts: settings.knownHosts, keyFile: settings.sshKey }, remote),
    { stdio: ["pipe", "pipe", "pipe"], env: Object.fromEntries(["PATH", "HOME", "LANG"].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])) });
  let output = Buffer.alloc(0), failed = false, killTimer;
  const terminate = () => {
    if (failed) return;
    failed = true; child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
  };
  const timer = setTimeout(terminate, 580000);
  child.stdout.on("data", chunk => { if (output.length + chunk.length > 65536) terminate(); else output = Buffer.concat([output, chunk]); });
  child.stderr.on("data", terminate); child.stdin.on("error", terminate);
  try {
    const code = await new Promise((done, fail) => { child.once("error", fail); child.once("close", done); child.stdin.end(raw); });
    demand(!failed && code === 0);
    return validateReceiverNegativeOutcome(JSON.parse(output.toString("utf8")), settings.reviewed);
  } finally { clearTimeout(timer); clearTimeout(killTimer); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [file, operation, confirmation, ...extra] = process.argv.slice(2);
    demand(file && extra.length === 0 && (operation === undefined || operation === "--execute"));
    const settings = JSON.parse(readFileSync(file, "utf8")), plan = prepareP2LifecycleReceiverPlan(settings.reviewed);
    if (operation === undefined) { demand(confirmation === undefined); process.stdout.write(JSON.stringify(plan) + "\n"); }
    else {
      demand(confirmation === "staging/" + plan.actionId);
      let bytes = 0; const chunks = [];
      for await (const chunk of process.stdin) { bytes += chunk.length; demand(bytes <= 262144); chunks.push(chunk); }
      const result = await executeP2LifecycleReceiverAction(settings, JSON.parse(Buffer.concat(chunks).toString("utf8")), confirmation);
      process.stdout.write(JSON.stringify(result) + "\n");
    }
  } catch {
    process.stdout.write(JSON.stringify({ version: 1, status: "P2_LIFECYCLE_RECEIVER_ACTION_REFUSED", globallyReadOnly: false,
      credentialsExposed: false, releaseAccepted: false }) + "\n"); process.exitCode = 1;
  }
}
