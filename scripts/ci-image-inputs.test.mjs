import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const script = fileURLToPath(new URL("./ci-image-inputs.mjs", import.meta.url));
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const workflowPath = ".github/workflows/ci.yml";

test("pull requests skip platform jobs and release CI requires them to pass", () => {
  const ci = parse(workflow);
  assert.deepEqual(ci.on.push.branches, ["main", "staging"]);
  assert(Object.hasOwn(ci.on, "workflow_dispatch"));
  for (const name of ["frontend-operator-migrations", "gateway-and-platform"]) {
    assert.equal(ci.jobs[name].if, "${{ github.event_name == 'push' || github.event_name == 'workflow_dispatch' }}");
    assert(ci.jobs.browser.needs.includes(name));
  }
  assert.equal(ci.jobs.browser.if, "${{ !cancelled() }}");
  const gate = ci.jobs.browser.steps.find(step => step.name === "Require expected CI dependency results");
  assert.equal(gate.env.EXPECTED_PLATFORM_RESULT, "${{ github.event_name == 'pull_request' && 'skipped' || 'success' }}");
  const check = (expected, migration, platform, dependencies = "true") =>
    spawnSync("bash", ["-e", "-c", gate.run], { env: {
      ...process.env,
      DEPENDENCIES_PASSED: dependencies,
      EXPECTED_PLATFORM_RESULT: expected,
      MIGRATION_RESULT: migration,
      PLATFORM_RESULT: platform,
    } }).status;
  assert.equal(check("skipped", "skipped", "skipped"), 0);
  assert.equal(check("skipped", "skipped", "skipped", "false"), 1);
  assert.equal(check("success", "success", "success"), 0);
  assert.equal(check("success", "skipped", "success"), 1);
  assert.equal(check("success", "success", "failure"), 1);
});

test("image qualification follows the changed inputs and full release dispatch", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ci-image-inputs-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (path, contents) => {
    const file = join(cwd, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
    git("add", "--", path);
    git("-c", "user.name=CI Test", "-c", "user.email=ci@example.invalid", "-c", "commit.gpgsign=false",
      "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Test input");
    return git("rev-parse", "HEAD");
  };
  const check = (type, event, expected) => {
    const eventPath = join(cwd, "event.json"), output = join(cwd, "output");
    writeFileSync(eventPath, JSON.stringify(event));
    const results = ["frontend", "gateway"].map(target => {
      writeFileSync(output, "");
      execFileSync(process.execPath, [script, target], {
        cwd, env: { ...process.env, GITHUB_EVENT_NAME: type, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output },
      });
      return readFileSync(output, "utf8").trim();
    });
    assert.deepEqual(results, expected.map(changed => `changed=${changed}`));
  };
  const push = (before, after, expected) => check("push", { before, after }, expected);

  git("init", "-q");
  try {
    const initial = commit(workflowPath, workflow);
    const documentation = commit("API-INTEGRATION-EXECUTION.md", "Documentation only\n");
    push(initial, documentation, [false, false]);
    const ui = commit("src/app/page.tsx", "export default function Page() { return null; }\n");
    push(documentation, ui, [false, false]);
    const gateway = commit("ops/gateway/server.mjs", "// gateway\n");
    push(ui, gateway, [false, true]);
    const migration = commit("drizzle/0001_fixture.sql", "-- migration\n");
    push(gateway, migration, [true, false]);
    const runtime = commit("ops/gateway/runtime/node-inputs.lock.json", "{}\n");
    push(migration, runtime, [true, true]);
    const workflowComment = commit(workflowPath, workflow + "\n# CI routing comment\n");
    push(runtime, workflowComment, [false, false]);
    const scanConfig = commit(workflowPath, workflow.replace("tags: lash-her-gateway:ci", "tags: lash-her-gateway:ci-next"));
    push(workflowComment, scanConfig, [false, true]);

    git("checkout", "--detach", ui);
    const prHead = commit("docs/guide.md", "A PR based on an earlier commit\n");
    check("pull_request", { pull_request: { base: { sha: scanConfig }, head: { sha: prHead } } }, [false, false]);
    push("0".repeat(40), prHead, [true, true]);
    check("workflow_dispatch", {}, [true, true]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
