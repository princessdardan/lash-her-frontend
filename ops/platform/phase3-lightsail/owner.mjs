import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";

const [mode, settingsFile, directory, approvedPlan, ...extra] = process.argv.slice(2);
assert.ok(settingsFile && isAbsolute(settingsFile) && extra.length === 0 &&
  (mode === "baseline" && !directory && !approvedPlan || mode === "plan" && directory && !approvedPlan ||
    mode === "apply" && directory && /^[a-f0-9]{64}$/u.test(approvedPlan ?? "")),
"Usage: node owner.mjs baseline <staging SSH settings> | plan <settings> <private package> | apply <settings> <private package> <verified host plan digest>");
const { releaseSettings: { arm: { host, knownHosts, sshKey } } } = JSON.parse(readFileSync(settingsFile, "utf8"));
assert.ok(/^[a-f0-9]{32}$/u.test(host.machineId) && isAbsolute(knownHosts) && isAbsolute(sshKey));
const program = readFileSync(new URL("./host.py", import.meta.url), "utf8");
const target = "ubuntu@184.196.129.231";
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const remote = ["sudo", "-n", "/usr/bin/python3", "-I", "-u", "-c", program, mode, host.machineId];
let payload;
if (mode !== "baseline") {
  const plan = JSON.parse(readFileSync(join(directory, "plan.json"), "utf8"));
  const inputs = Object.fromEntries(["job.json", "schema.json", "predecessor-schema.json", "fixture.json", "review.json"]
    .map(name => [name, readFileSync(join(directory, name), "utf8")]));
  const digest = createHash("sha256").update(inputs["review.json"]).digest("hex");
  assert.equal(digest, plan.reviewSha256);
  assert.equal(plan.productionTarget, false);
  remote.push(digest);
  payload = JSON.stringify({ plan, inputs });
  if (mode === "apply") {
    assert.ok(process.stdin.isTTY && process.stdout.isTTY, "Explicit operator start requires a terminal");
    console.log(JSON.stringify(plan, null, 2));
    console.log("The reviewed action applies one Course schema migration and imports one synthetic draft. The existing runtimes and closed admission stay in place.");
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (await terminal.question("Type IMPORT PHASE 3 STAGING DRAFT to proceed: ") !== "IMPORT PHASE 3 STAGING DRAFT") process.exit(2);
    } finally { terminal.close(); }
    remote.push(approvedPlan);
  }
}
const child = spawn("/usr/bin/ssh", ["-T", "-i", sshKey, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
  "-o", "StrictHostKeyChecking=yes", "-o", "GlobalKnownHostsFile=/dev/null", "-o", `UserKnownHostsFile=${knownHosts}`,
  "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", target,
  remote.map(quote).join(" ")], { stdio: ["pipe", "inherit", "inherit"] });
child.stdin.on("error", () => {});
child.stdin.end(payload);
const [code] = await once(child, "close");
process.exitCode = code ?? 1;
