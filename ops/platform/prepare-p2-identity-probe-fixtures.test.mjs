import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseP2IdentityProbeTap, prepareP2IdentityProbeFixtures, validateP2IdentityFixtureManifest } from "./prepare-p2-identity-probe-fixtures.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const revisions = { course: "3c0a0d6eee64344d97f98387755e9f34195a4c42", community: "1ce696a7ae6073cb125da19146789693398b6cc4" };
const contents = { course: Buffer.from('{"openapi":"3.1.0","info":{"title":"course"}}\n'), community: Buffer.from('{"openapi":"3.1.0","info":{"title":"community"}}\n'),
  enrollmentEvent: Buffer.from('{"$schema":"https://json-schema.org/draft/2020-12/schema"}\n') };
const sourceReadToken = "fixture-source-token-value-not-secret";

function withSourceReadToken(value, operation) {
  const present = Object.hasOwn(process.env, "PLATFORM_SOURCE_READ_TOKEN");
  const previous = process.env.PLATFORM_SOURCE_READ_TOKEN;
  if (value === undefined) delete process.env.PLATFORM_SOURCE_READ_TOKEN;
  else process.env.PLATFORM_SOURCE_READ_TOKEN = value;
  try { return operation(); }
  finally {
    if (present) process.env.PLATFORM_SOURCE_READ_TOKEN = previous;
    else delete process.env.PLATFORM_SOURCE_READ_TOKEN;
  }
}

function fixtureManifest() {
  return { version: 1, status: "released", frontendBaseRevision: "a".repeat(40), boundarySha256: "b".repeat(64), readmeSha256: "c".repeat(64), artifacts: {
    course: { repository: "lash-her-course-api", revision: revisions.course, sourcePath: "openapi/course-api.json", file: "course-api.json", sha256: sha(contents.course) },
    community: { repository: "lash-her-community-api", revision: revisions.community, sourcePath: "openapi/community-api.json", file: "community-api.json", sha256: sha(contents.community) },
    enrollmentEvent: { repository: "lash-her-community-api", revision: revisions.community, sourcePath: "contracts/course-enrollment/v1/enrollment-event.schema.json",
      file: "enrollment-event.schema.json", sha256: sha(contents.enrollmentEvent) },
  } };
}

function tap(changes = {}) {
  const fields = { tests: 19, pass: 19, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...changes };
  return `TAP version 13\n1..${fields.tests}\n${Object.entries(fields).map(([name, value]) => `# ${name} ${value}`).join("\n")}\n`;
}

function harness(testOutput = tap()) {
  const root = mkdtempSync(join(tmpdir(), "p2-identity-prep-root-"));
  const workspace = mkdtempSync(join(tmpdir(), "p2-identity-prep-work-"));
  chmodSync(root, 0o700); chmodSync(workspace, 0o700);
  mkdirSync(join(root, "contracts/api-integration/p2-candidate"), { recursive: true });
  writeFileSync(join(root, "contracts/api-integration/p2-candidate/manifest.json"), JSON.stringify(fixtureManifest()));
  const calls = [];
  const run = (file, args, options) => {
    calls.push({ file, args: [...args], cwd: options.cwd, env: { ...options.env } });
    const ok = stdout => ({ status: 0, signal: null, stdout, stderr: "" });
    if (file === "npm" && args[0] === "--version") return ok("11.7.0\n");
    if (file === "npm") return ok("");
    if (file !== "git") {
      assert.deepEqual(args, ["--test", "--test-reporter=tap", "ops/platform/p2-identity-negative-probe.test.mjs"]);
      return ok(testOutput);
    }
    if (args[0] === "checkout") assert.fail("checkout must retain the fixed -c prefix");
    if (args.includes("checkout")) {
      const service = options.cwd.endsWith("lash-her-course-api") ? "course" : "community";
      writeFileSync(join(options.cwd, "package.json"), JSON.stringify({ name: `lash-her-${service}-api`, scripts: { "build:production": "tsc -p tsconfig.build.json" } }));
      writeFileSync(join(options.cwd, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
      if (service === "course") {
        mkdirSync(join(options.cwd, "openapi"), { recursive: true }); writeFileSync(join(options.cwd, "openapi/course-api.json"), contents.course);
      } else {
        mkdirSync(join(options.cwd, "openapi"), { recursive: true }); mkdirSync(join(options.cwd, "contracts/course-enrollment/v1"), { recursive: true });
        writeFileSync(join(options.cwd, "openapi/community-api.json"), contents.community);
        writeFileSync(join(options.cwd, "contracts/course-enrollment/v1/enrollment-event.schema.json"), contents.enrollmentEvent);
      }
      return ok("");
    }
    if (args.join(" ") === "rev-parse HEAD") {
      if (options.cwd === root) return ok("d".repeat(40) + "\n");
      return ok((options.cwd.endsWith("lash-her-course-api") ? revisions.course : revisions.community) + "\n");
    }
    if (args.join(" ") === "rev-parse HEAD^{tree}") return ok((options.cwd.endsWith("lash-her-course-api") ? "e" : "f").repeat(40) + "\n");
    if (args.join(" ") === "remote get-url origin") return ok(options.cwd.endsWith("lash-her-course-api") ?
      "https://github.com/princessdardan/lash-her-course-api.git\n" : "https://github.com/princessdardan/lash-her-community-api.git\n");
    return ok("");
  };
  return { root, workspace, calls, run, cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); } };
}

test("prepares exact manifest sources with fixed clean builds and requires all 19 actual tests", () => {
  const value = harness();
  try {
    const result = withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
      run: value.run, makeTemporaryDirectory: () => value.workspace }));
    assert.equal(result.status, "P2_IDENTITY_PROBE_FIXTURES_PASS");
    assert.equal(JSON.stringify(result).includes(sourceReadToken), false);
    assert.deepEqual(result.tests, { tests: 19, pass: 19, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
    assert.equal(result.sources.course.revision, revisions.course); assert.equal(result.sources.community.revision, revisions.community);
    assert.equal(result.scriptsIgnoredDuringInstall, true); assert.equal(result.databaseConnected, false); assert.equal(existsSync(value.workspace), false);
    const fetches = value.calls.filter(call => call.file === "git" && call.args[0] === "fetch");
    assert.deepEqual(fetches.map(call => call.args), [["fetch", "--no-tags", "--depth=1", "origin", revisions.course], ["fetch", "--no-tags", "--depth=1", "origin", revisions.community]]);
    for (const fetch of fetches) {
      assert.equal(fetch.env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
      assert.equal(fetch.env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${sourceReadToken}`).toString("base64")}`);
      assert.equal(JSON.stringify(fetch.args).includes(sourceReadToken), false);
    }
    assert.deepEqual(value.calls.filter(call => call.file === "git" && call.args[0] === "remote" && call.args[1] === "add").map(call => call.args),
      [["remote", "add", "origin", "https://github.com/princessdardan/lash-her-course-api.git"],
        ["remote", "add", "origin", "https://github.com/princessdardan/lash-her-community-api.git"]]);
    const installs = value.calls.filter(call => call.file === "npm" && call.args[0] === "ci");
    assert.equal(installs.length, 2);
    for (const install of installs) assert.deepEqual(install.args, ["ci", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"]);
    const builds = value.calls.filter(call => call.file === "npm" && call.args[0] === "run");
    assert.equal(builds.length, 2);
    for (const build of builds) { assert.deepEqual(build.args, ["run", "build:production"]); assert.equal(build.env.NODE_ENV, "production"); }
    const probe = value.calls.find(call => call.file !== "git" && call.file !== "npm");
    assert.equal(probe.env.NODE_ENV, "test");
    assert.equal(probe.env.P2_IDENTITY_COURSE_RUNTIME_DIR.endsWith("/lash-her-course-api"), true);
    assert.equal(probe.env.P2_IDENTITY_COMMUNITY_RUNTIME_DIR.endsWith("/lash-her-community-api"), true);
    for (const call of value.calls.filter(call => !(call.file === "git" && call.args[0] === "fetch"))) {
      assert.equal(Object.hasOwn(call.env, "GIT_CONFIG_VALUE_0"), false);
      assert.equal(call.env.npm_config_userconfig.endsWith("/npm-userconfig"), true);
      assert.equal(call.env.npm_config_globalconfig.endsWith("/npm-globalconfig"), true);
    }
    for (const call of value.calls) for (const forbidden of ["DATABASE_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "CRON_SECRET", "VERCEL_TOKEN", "NODE_OPTIONS"])
      assert.equal(Object.hasOwn(call.env, forbidden), false, `${forbidden} must not enter ${call.file}`);
  } finally { value.cleanup(); }
});

test("refuses a noncanonical repository, mismatched event revision, or artifact digest", () => {
  for (const mutate of [value => { value.artifacts.course.repository = "foreign-course"; }, value => { value.artifacts.enrollmentEvent.revision = "9".repeat(40); },
    value => { value.artifacts.community.sha256 = "0".repeat(64); }]) {
    const value = fixtureManifest(); mutate(value);
    assert.throws(() => validateP2IdentityFixtureManifest(Buffer.from(JSON.stringify(value))), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
  }
});

test("refuses skipped, failed, partial, or duplicated TAP summaries", () => {
  for (const output of [tap({ pass: 18, skipped: 1 }), tap({ pass: 18, fail: 1 }), tap({ tests: 18, pass: 18 }), tap() + "# pass 19\n"])
    assert.throws(() => parseP2IdentityProbeTap(output), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
});

test("refuses a non-Node-24 executor before source fetch", () => {
  const value = harness();
  try {
    assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "26.5.0", run: value.run,
      makeTemporaryDirectory: () => value.workspace })), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
    assert.equal(value.calls.length, 0); assert.equal(existsSync(value.workspace), true);
  } finally { value.cleanup(); }
});

test("refuses a missing or structurally unsafe private source token before Git", () => {
  for (const token of [undefined, "short", "x".repeat(19) + "\n"]) {
    const value = harness();
    try {
      assert.throws(() => withSourceReadToken(token, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
        run: value.run, makeTemporaryDirectory: () => value.workspace })), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
      assert.equal(value.calls.some(call => call.file === "git" && call.args[0] === "fetch"), false);
    } finally { value.cleanup(); }
  }
});

test("removes the complete disposable checkout after a build refusal", () => {
  const value = harness();
  try {
    const refusingRun = (file, args, options) => file === "npm" && args[0] === "run" ?
      { status: 1, signal: null, stdout: "", stderr: "private diagnostic must not escape" } : value.run(file, args, options);
    assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
      run: refusingRun, makeTemporaryDirectory: () => value.workspace })), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
    assert.equal(existsSync(value.workspace), false);
  } finally { value.cleanup(); }
});

test("fixture manifest used by the test remains byte readable", () => {
  const value = harness();
  try { assert.equal(validateP2IdentityFixtureManifest(readFileSync(join(value.root, "contracts/api-integration/p2-candidate/manifest.json"))).status, "released"); }
  finally { value.cleanup(); }
});
