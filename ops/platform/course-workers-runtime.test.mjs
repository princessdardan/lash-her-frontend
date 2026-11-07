import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { courseWorkerPolicies } from "./configuration.mjs";

// Opt in with a reviewed built Course source directory. Normal frontend CI has
// no Course dist tree; a skipped case is not runtime qualification evidence.
const runtime = process.env.COURSE_WORKER_RUNTIME_DIR;
const minimal = { NODE_ENV: "production", DATABASE_TARGET: "staging", STAGING_DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/worker_test?sslmode=verify-full" };
const delay = ms => new Promise(done => setTimeout(done, ms));

for (const [name, policy] of Object.entries(courseWorkerPolicies)) {
  test(`${name}: compiled minimal parser rejects malformed enablement and requires no API credentials`, { skip: !runtime }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "course-worker-config-"));
    try {
      const url = pathToFileURL(resolve(runtime, policy.configModule)).href;
      const code = `const {${policy.configParser}: parse}=await import(${JSON.stringify(url)}); const source=${JSON.stringify(minimal)}; const config=parse(source); if(config.enabled!==false || config.port<1) throw new Error("Disabled default required"); for(const flag of ${JSON.stringify(policy.disabledFlags)}) { let refused=false; try {parse({...source,[flag]:"yes"});} catch {refused=true;} if(!refused) throw new Error("Malformed flag accepted"); } console.log("MINIMAL_CONFIG_PASS");`;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { cwd, env: {}, encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /MINIMAL_CONFIG_PASS/u);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test(`${name}: actual disabled process exposes liveness, denies readiness without DB and exits on SIGTERM`, { skip: !runtime, timeout: 15000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "course-worker-process-"));
    const reserve = createServer();
    await new Promise((done, reject) => { reserve.once("error", reject); reserve.listen(0, "127.0.0.1", done); });
    const port = reserve.address().port;
    await new Promise(done => reserve.close(done));
    const child = spawn(process.execPath, [resolve(runtime, policy.command)], {
      cwd, env: { ...minimal, PORT: String(port), NODE_OPTIONS: "--max-old-space-size=128" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    const exited = new Promise(done => child.once("exit", (code, signal) => done({ code, signal })));
    try {
      let live = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        try { live = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* Process may still be starting. */ }
        if (live || child.exitCode !== null) break;
        await delay(50);
      }
      assert.ok(live, output);
      const metrics = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(3500) });
      assert.equal(metrics.status, 200);
      assert.match(await metrics.text(), /_enabled 0/u);
      const ready = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(3500) });
      assert.equal(ready.status, 503);
      assert.doesNotMatch(await ready.text(), /synthetic|postgresql|127\.0\.0\.1/u);
      child.kill("SIGTERM");
      const result = await Promise.race([exited, delay(3000).then(() => null)]);
      assert.deepEqual(result, { code: 0, signal: null }, output);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
