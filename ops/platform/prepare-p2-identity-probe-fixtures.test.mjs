import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { p2IdentityFixtureFailureReceipt, parseP2DockerContextEndpoint, parseP2ForwardRecoveryPostgres18Receipt, parseP2IdentityProbeTap,
  parseP2RecoveryPostgres18Receipt, prepareP2IdentityProbeFixtures,
  validateP2IdentityFixtureManifest } from "./prepare-p2-identity-probe-fixtures.mjs";

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

function recoveryReceipt(changes = {}) {
  const apiFaults = ["runtime-inbound", "migration-inbound", "runtime-outbound", "sequence-update", "table-trigger", "table-references",
    "default-unexpected-grantee", "default-sequence-update", "global-default", "table-grant-option", "default-grant-option"];
  const privilegeFaults = ["frontend-runtime-inbound", "frontend-runtime-outbound", "frontend-runtime-rogue-admin", "frontend-owner-inbound",
    "frontend-owner-outbound", "frontend-sequence-update", "frontend-default-unexpected-grantee", "frontend-global-default",
    "frontend-table-grant-option", "frontend-default-grant-option", "frontend-table-references", "frontend-table-trigger",
    "frontend-operator-superuser", "frontend-runtime-role-settings", "frontend-runtime-rogue-ownership",
    "frontend-runtime-database-settings", "frontend-runtime-public-schema-access",
    ...["course", "community"].flatMap(service => apiFaults.map(fault => `${service}-${fault}`))].sort();
  return JSON.stringify({ status: "OWNED_P2_RECOVERY_DATABASE_CHECKS_PASS", serverMajor: 18, frontendMigrations: 83,
    courseMigrations: 22, communityMigrations: 11, checks: 55, skipped: 0, fixtureOnly: true, providerTouched: false,
    privilegeFaults, frontendInitialPrivilegeRefusals: 17, frontendContinuousPrivilegeRefusals: 17, apiPrivilegeRefusals: 22,
    legacyApiVerifierRefusals: 2, frontendCreatorPolicy: "actual-non-superuser-automatic-admin-plus-explicit-owner-set",
    frontendCreatorMemberships: 3, frontendOperatorSearchPathPinned: true,
    environmentIsolation: { nodeOptionsPositiveControlExecuted: true, poisonedParentEnvironment: true,
      ambientNodeOptionsExecuted: false, ambientConfigVariablesAbsent: true, childEnvironmentAllowlistEnforced: true },
    noSqlReplay: true, originalFrontendTerminalRecreated: false,
    ...changes }) + "\n";
}

function forwardRecoveryReceipt(changes = {}) {
  return JSON.stringify({ status: "OWNED_P2_RECOVERY_FORWARD_CHECKS_PASS", serverMajor: 18, frontendMigrations: 83,
    courseMigrations: 22, communityMigrations: 11,
    checks: ["actual-fe-physical-session", "both-api-current-readonly", "actual-tls-build-probe-promote", "same-source-candidate-new-action",
      "real-opaque-scope-shared-observer", "selected-workload-bytes", "cloned-plain-scope-refused", "wrong-client-verifier-refused",
      "wrong-plan-candidate-target-directory-refused", "wrong-inventory-action-refused", "shared-mutation-operations-refused",
      "receipt-drift-refused", "expired-session-refused", "open-admission-mutation-refused", "opened-admission-get-retained",
      "original-terminal-retained-not-current", "original-receipts-preserved"],
    mutationRefusals: 1, noSqlReplay: true, journalDigestsUnchanged: true, originalFrontendTerminalRecreated: false,
    skipped: 0, fixtureOnly: true, providerTouched: false, actualRuntimeContainers: false,
    environmentIsolation: { nodeOptionsPositiveControlExecuted: true, poisonedParentEnvironment: true,
      ambientNodeOptionsExecuted: false, ambientConfigVariablesAbsent: true, childEnvironmentAllowlistEnforced: true },
    ...changes }) + "\n";
}

function harness(testOutput = tap(), ignoredFrontendOutputs = [], trackedDependencyRoots = ["ops/gateway", "tools/api-contract-toolchain"], settings = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "p2-identity-prep-root-")));
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "p2-identity-prep-work-")));
  chmodSync(root, 0o700); chmodSync(workspace, 0o700);
  for (const directory of ["contracts/api-integration/p2-candidate", "contracts/api-integration/v1", "ops/platform", "ops/gateway", "drizzle",
    "node_modules", "src", "scripts"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "contracts/api-integration/p2-candidate/manifest.json"), JSON.stringify(fixtureManifest()));
  writeFileSync(join(root, "ops/platform/test-p2-recovery-owned.py"), "# owned fixture\n");
  writeFileSync(join(root, "ops/platform/test-p2-recovery-owned.mjs"), "// owned fixture\n");
  writeFileSync(join(root, "ops/gateway/routes.json"), "{}\n");
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  const calls = [];
  const dockerModes = [];
  const dockerSocketPath = join(workspace, "docker.sock");
  const dockerSocketStat = path => {
    if (path !== dockerSocketPath || settings.dockerSocketMissing === true) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { isSocket: () => true, isSymbolicLink: () => false, uid: process.getuid() };
  };
  const run = (file, args, options) => {
    calls.push({ file, args: [...args], cwd: options.cwd, env: { ...options.env } });
    const ok = stdout => ({ status: 0, signal: null, stdout, stderr: "" });
    if (file === "npm" && args[0] === "--version") return ok("11.7.0\n");
    if (file === "npm") return ok("");
    if (file === "docker") {
      if (args[0] === "context") return ok(settings.dockerContextOutput ?? JSON.stringify(`unix://${dockerSocketPath}`) + "\n");
      dockerModes.push({ workspace: lstatSync(workspace).mode & 0o777,
        course: lstatSync(join(workspace, "lash-her-course-api")).mode & 0o777,
        community: lstatSync(join(workspace, "lash-her-community-api")).mode & 0o777 });
      const forward = args.at(-1) === "--forward-brand", prefix = forward ? "forwardRecovery" : "recovery";
      return settings[`${prefix}Result`] ?? { status: settings[`${prefix}Status`] ?? 0, signal: settings[`${prefix}Signal`] ?? null,
        stdout: settings[`${prefix}Output`] ?? (forward ? forwardRecoveryReceipt() : recoveryReceipt()), stderr: settings[`${prefix}Stderr`] ?? "" };
    }
    if (file !== "git") {
      assert.deepEqual(args, ["--test", "--test-reporter=tap", "ops/platform/p2-identity-negative-probe.test.mjs"]);
      return ok(testOutput);
    }
    if (options.cwd === root && args.includes("--ignored")) return ok(ignoredFrontendOutputs.join("\0") + (ignoredFrontendOutputs.length ? "\0" : ""));
    if (options.cwd === root && args.includes("--error-unmatch")) {
      const tracked = trackedDependencyRoots.some(path => args.at(-1) === `${path}/package-lock.json`);
      return tracked ? ok(args.at(-1) + "\n") : { status: 1, signal: null, stdout: "", stderr: "not tracked" };
    }
    if (args[0] === "checkout") assert.fail("checkout must retain the fixed -c prefix");
    if (args.includes("checkout")) {
      const service = options.cwd.endsWith("lash-her-course-api") ? "course" : "community";
      mkdirSync(join(options.cwd, ".git"), { recursive: true });
      const url = service === "course" ? "https://github.com/princessdardan/lash-her-course-api.git" :
        "https://github.com/princessdardan/lash-her-community-api.git";
      writeFileSync(join(options.cwd, ".git/config"), `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n${settings.apiGitConfigSuffix ?? ""}`);
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
  return { root, workspace, calls, dockerModes, dockerSocketPath, dockerSocketStat, run,
    cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); } };
}

test("prepares exact manifest sources with fixed clean builds and requires all 19 actual tests", () => {
  const value = harness(tap(), ["ops/gateway/node_modules/typescript/lib/typescript.js",
    "tools/api-contract-toolchain/node_modules/ajv/dist/ajv.js", "ops/platform/host/__pycache__/probe.cpython-312.pyc"]);
  try {
    const result = withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
      run: value.run, makeTemporaryDirectory: () => value.workspace }));
    assert.equal(result.status, "P2_IDENTITY_PROBE_FIXTURES_PASS");
    assert.equal(result.fixtureOnly, true); assert.equal(result.providerTouched, false); assert.equal(result.skipped, 0);
    assert.equal(result.databaseConnected, false); assert.equal(result.sqlExecuted, false); assert.equal(result.ownedDisposableDatabase, false);
    assert.equal(JSON.stringify(result).includes(sourceReadToken), false);
    assert.deepEqual(result.tests, { tests: 19, pass: 19, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
    assert.equal(result.sources.course.revision, revisions.course); assert.equal(result.sources.community.revision, revisions.community);
    assert.equal(result.scriptsIgnoredDuringInstall, true); assert.equal(result.databaseConnected, false); assert.equal(existsSync(value.workspace), false);
    assert.equal(value.calls.some(call => call.file === "docker"), false);
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

test("recovery mode runs current and forward PostgreSQL 18 fixtures after all identity checks in separate containers", () => {
  const value = harness();
  try {
    const result = withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
      recoveryPostgres18: true, run: value.run, dockerSocketStat: value.dockerSocketStat, makeTemporaryDirectory: () => value.workspace }));
    assert.equal(result.status, "P2_IDENTITY_AND_RECOVERY_FIXTURES_PASS");
    assert.equal(result.fixtureOnly, true); assert.equal(result.providerTouched, false); assert.equal(result.skipped, 0);
    assert.equal(result.databaseConnected, true); assert.equal(result.sqlExecuted, true); assert.equal(result.ownedDisposableDatabase, true);
    assert.equal(result.recovery.status, "OWNED_P2_RECOVERY_DATABASE_CHECKS_PASS");
    assert.equal(result.recovery.serverMajor, 18); assert.equal(result.recovery.frontendMigrations, 83);
    assert.equal(result.recovery.courseMigrations, 22); assert.equal(result.recovery.communityMigrations, 11);
    assert.equal(result.recovery.checks, 55); assert.equal(result.recovery.skipped, 0); assert.equal(result.recovery.privilegeFaults.length, 39);
    assert.equal(result.recovery.frontendInitialPrivilegeRefusals, 17); assert.equal(result.recovery.frontendContinuousPrivilegeRefusals, 17);
    assert.equal(result.recovery.apiPrivilegeRefusals, 22); assert.equal(result.recovery.legacyApiVerifierRefusals, 2);
    assert.equal(result.recovery.frontendOperatorSearchPathPinned, true);
    assert.equal(result.recovery.environmentIsolation.childEnvironmentAllowlistEnforced, true);
    assert.equal(result.forwardRecovery.status, "OWNED_P2_RECOVERY_FORWARD_CHECKS_PASS");
    assert.equal(result.forwardRecovery.serverMajor, 18); assert.equal(result.forwardRecovery.frontendMigrations, 83);
    assert.equal(result.forwardRecovery.courseMigrations, 22); assert.equal(result.forwardRecovery.communityMigrations, 11);
    assert.equal(result.forwardRecovery.checks.length, 17); assert.equal(result.forwardRecovery.mutationRefusals, 1);
    assert.equal(result.forwardRecovery.skipped, 0); assert.equal(result.forwardRecovery.actualRuntimeContainers, false);
    assert.equal(result.forwardRecovery.journalDigestsUnchanged, true); assert.equal(result.forwardRecovery.noSqlReplay, true);
    assert.deepEqual(result.forwardRecovery.apiSourcePins.course, { revision: revisions.course, gitTree: "e".repeat(40),
      packageSha256: result.sources.course.packageSha256, packageLockSha256: result.sources.course.packageLockSha256,
      artifactSha256: { course: sha(contents.course) } });
    assert.deepEqual(result.forwardRecovery.apiSourcePins.community, { revision: revisions.community, gitTree: "f".repeat(40),
      packageSha256: result.sources.community.packageSha256, packageLockSha256: result.sources.community.packageLockSha256,
      artifactSha256: { community: sha(contents.community), enrollmentEvent: sha(contents.enrollmentEvent) } });
    assert.equal(JSON.stringify(result).includes(sourceReadToken), false);
    const contextIndex = value.calls.findIndex(call => call.file === "docker" && call.args[0] === "context");
    const dockerCalls = value.calls.filter(call => call.file === "docker" && call.args[0] === "--host");
    const dockerIndex = value.calls.indexOf(dockerCalls[0]), forwardIndex = value.calls.indexOf(dockerCalls[1]);
    const identityIndex = value.calls.findIndex(call => call.file !== "docker" && call.file !== "git" && call.file !== "npm");
    assert.equal(dockerCalls.length, 2);assert.equal(identityIndex >= 0 && contextIndex > identityIndex && dockerIndex > contextIndex && forwardIndex > dockerIndex, true);
    const context = value.calls[contextIndex];
    assert.deepEqual(context.args, ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]);
    assert.deepEqual(Object.keys(context.env).sort(), ["HOME", "LANG", "LC_ALL", "PATH"]);
    const docker = dockerCalls[0], forwardDocker = dockerCalls[1];
    assert.deepEqual(docker.args.slice(0, 3), ["--host", `unix://${value.dockerSocketPath}`, "run"]);
    for (const argument of ["--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--memory=1g", "--pids-limit=256", "--shm-size=256m", "--tmpfs=/tmp:rw,nosuid,nodev,size=512m,mode=1777",
      "--env=PG_BIN=/usr/lib/postgresql/18/bin", "--env=OWNED_POSTGRES_MAJOR=18", "--env=P2_RECOVERY_OWNED_TEST=true",
      "--env=NODE_BIN=/usr/local/bin/node", "--env=COURSE_RECOVERY_SOURCE_ROOT=/exact-sources/lash-her-course-api",
      "--env=COMMUNITY_RECOVERY_SOURCE_ROOT=/exact-sources/lash-her-community-api", "--entrypoint=python3",
      "lash-her-frontend-migration:postgres18-test", "ops/platform/test-p2-recovery-owned.py"]) assert.equal(docker.args.includes(argument), true, argument);
    assert.equal(docker.args.includes("--forward-brand"), false);assert.equal(forwardDocker.args.at(-1), "--forward-brand");
    assert.deepEqual(forwardDocker.args.slice(0,-1),docker.args);
    const mounts = docker.args.filter((argument, index) => docker.args[index - 1] === "--mount");
    assert.equal(mounts.length, 12); assert.equal(mounts.every(value => value.endsWith(",readonly")), true);
    assert.equal(mounts.some(value => value.includes("dst=/exact-sources/lash-her-course-api")), true);
    assert.equal(mounts.some(value => value.includes("dst=/exact-sources/lash-her-community-api")), true);
    assert.equal(mounts.some(value => value.includes(`src=${value.workspace},`)), false);
    assert.deepEqual(Object.keys(docker.env).sort(), ["DOCKER_CONFIG", "HOME", "LANG", "LC_ALL", "PATH"]);
    assert.deepEqual(forwardDocker.env,docker.env);
    assert.deepEqual(value.dockerModes, [{ workspace: 0o700, course: 0o755, community: 0o755 },
      { workspace: 0o700, course: 0o755, community: 0o755 }]);
  } finally { value.cleanup(); }
});

test("Docker context accepts only an existing local Unix socket", () => {
  const socket = "/tmp/lash-her-owned-docker.sock";
  const ownedSocket = path => {
    assert.equal(path, socket);
    return { isSocket: () => true, isSymbolicLink: () => false, uid: process.getuid() };
  };
  assert.equal(parseP2DockerContextEndpoint(JSON.stringify(`unix://${socket}`), ownedSocket), `unix://${socket}`);
  for (const endpoint of ["tcp://127.0.0.1:2375", "ssh://operator@example.test", "unix://operator:secret@/tmp/docker.sock",
    "unix:///tmp/docker.sock?option=true", "unix://relative.sock", "not-json"]) {
    assert.throws(() => parseP2DockerContextEndpoint(endpoint === "not-json" ? endpoint : JSON.stringify(endpoint), ownedSocket),
      /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED|SyntaxError/u, endpoint);
  }
  assert.throws(() => parseP2DockerContextEndpoint(JSON.stringify(`unix://${socket}`), () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }), /missing/u);
  for (const info of [
    { isSocket: () => false, isSymbolicLink: () => false },
    { isSocket: () => true, isSymbolicLink: () => true },
  ]) assert.throws(() => parseP2DockerContextEndpoint(JSON.stringify(`unix://${socket}`), () => info),
    /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
});

test("recovery failures expose only fixed Docker transport and child exit diagnostics", () => {
  for (const scenario of [
    { settings: { dockerContextOutput: JSON.stringify("tcp://127.0.0.1:2375") }, expected: "docker-transport", attempted: false },
    { settings: { dockerSocketMissing: true }, expected: "docker-transport", attempted: false },
    { settings: { recoveryStatus: 125, recoveryOutput: "private-output", recoveryStderr: "private-error" }, expected: "docker-transport", attempted: true },
    { settings: { recoveryStatus: 1, recoveryOutput: "private-output", recoveryStderr: "private-error" }, expected: "child-exit", attempted: true },
  ]) {
    const value = harness(tap(), [], ["ops/gateway", "tools/api-contract-toolchain"], scenario.settings);
    try {
      let receipt;
      assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
        recoveryPostgres18: true, run: value.run, dockerSocketStat: value.dockerSocketStat, makeTemporaryDirectory: () => value.workspace })),
      error => { receipt = p2IdentityFixtureFailureReceipt(error); return true; });
      assert.equal(receipt.phase, "recovery-postgres18"); assert.equal(receipt.stage, "recovery");
      assert.equal(receipt.recoveryQualification, "current");
      assert.equal(receipt.recoveryFailure, scenario.expected);
      assert.equal(receipt.ownedDisposableDatabaseExecutionAttempted, scenario.attempted);
      assert.equal(JSON.stringify(receipt).includes("private-"), false);
    } finally { value.cleanup(); }
  }
});

test("recovery mode refuses persisted API Git authentication before permission changes or Docker", () => {
  const value = harness(tap(), [], ["ops/gateway", "tools/api-contract-toolchain"],
    { apiGitConfigSuffix: `[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic ${sourceReadToken}\n` });
  try {
    assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
      recoveryPostgres18: true, run: value.run, makeTemporaryDirectory: () => value.workspace })), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
    assert.equal(value.calls.some(call => call.file === "docker"), false);
  } finally { value.cleanup(); }
});

test("recovery mode refuses a frontend mount that resolves outside the exact source", () => {
  const value = harness();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "p2-identity-private-outside-")));
  try {
    rmSync(join(value.root, "node_modules"), { recursive: true });
    symlinkSync(outside, join(value.root, "node_modules"), "dir");
    assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
      recoveryPostgres18: true, run: value.run, makeTemporaryDirectory: () => value.workspace })), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
    assert.equal(value.calls.some(call => call.file === "docker"), false);
  } finally { value.cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test("refuses ignored source, environment configuration, and unreviewed dependency roots", () => {
  for (const ignored of ["src/auth/foreign.ts", ".env.staging", "ops/foreign/node_modules/runtime/index.js", "tsconfig.hidden.json"]) {
    const value = harness(tap(), [ignored]);
    try {
      assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
        run: value.run, makeTemporaryDirectory: () => value.workspace })), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u, ignored);
      assert.equal(value.calls.some(call => call.file === "git" && call.args[0] === "fetch"), false);
    } finally { value.cleanup(); }
  }
  const missingLock = harness(tap(), ["ops/gateway/node_modules/runtime/index.js"], []);
  try {
    assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: missingLock.root, nodeVersion: "24.18.0",
      run: missingLock.run, makeTemporaryDirectory: () => missingLock.workspace })), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
    assert.equal(missingLock.calls.some(call => call.file === "git" && call.args[0] === "fetch"), false);
  } finally { missingLock.cleanup(); }
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

test("recovery receipt refuses wrong major, migration counts, skips, replay, or extra output", () => {
  for (const output of [recoveryReceipt({ serverMajor: 16 }), recoveryReceipt({ frontendMigrations: 82 }),
    recoveryReceipt({ courseMigrations: 21 }), recoveryReceipt({ communityMigrations: 10 }), recoveryReceipt({ skipped: 1 }),
    recoveryReceipt({ checks: 14 }), recoveryReceipt({ checks: 50 }), recoveryReceipt({ privilegeFaults: [] }),
    recoveryReceipt({ frontendInitialPrivilegeRefusals: 16 }), recoveryReceipt({ frontendContinuousPrivilegeRefusals: 16 }),
    recoveryReceipt({ apiPrivilegeRefusals: 21 }),
    recoveryReceipt({ legacyApiVerifierRefusals: 1 }), recoveryReceipt({ frontendCreatorMemberships: 2 }),
    recoveryReceipt({ frontendOperatorSearchPathPinned: false }),
    recoveryReceipt({ environmentIsolation: { nodeOptionsPositiveControlExecuted: true } }), recoveryReceipt({ noSqlReplay: false }),
    recoveryReceipt({ originalFrontendTerminalRecreated: true }), recoveryReceipt() + "private-output\n"])
    assert.throws(() => parseP2RecoveryPostgres18Receipt(output), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
});

test("forward recovery receipt refuses wrong mode, PG16, echoed current proof, missing checks, skips, and runtime claims", () => {
  const checks = JSON.parse(forwardRecoveryReceipt()).checks;
  for (const output of [recoveryReceipt(), forwardRecoveryReceipt({ status: "OWNED_P2_RECOVERY_DATABASE_CHECKS_PASS" }),
    forwardRecoveryReceipt({ serverMajor: 16 }), forwardRecoveryReceipt({ frontendMigrations: 82 }),
    forwardRecoveryReceipt({ courseMigrations: 21 }), forwardRecoveryReceipt({ communityMigrations: 10 }),
    forwardRecoveryReceipt({ checks: checks.slice(0,-1) }), forwardRecoveryReceipt({ checks: [...checks,checks[0]] }),
    forwardRecoveryReceipt({ mutationRefusals: 0 }), forwardRecoveryReceipt({ skipped: 1 }),
    forwardRecoveryReceipt({ noSqlReplay: false }), forwardRecoveryReceipt({ journalDigestsUnchanged: false }),
    forwardRecoveryReceipt({ originalFrontendTerminalRecreated: true }), forwardRecoveryReceipt({ actualRuntimeContainers: true }),
    forwardRecoveryReceipt({ environmentIsolation: { childEnvironmentAllowlistEnforced: true } }),
    forwardRecoveryReceipt({ unreviewedExtra: true }), forwardRecoveryReceipt() + "private-output\n"])
    assert.throws(() => parseP2ForwardRecoveryPostgres18Receipt(output), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
});

test("a forward qualification failure reports only the fixed forward mode and no child output", () => {
  for (const settings of [
    { forwardRecoveryStatus: 125, forwardRecoveryOutput: "private-output", forwardRecoveryStderr: "private-error" },
    { forwardRecoveryStatus: 1, forwardRecoveryOutput: "private-output", forwardRecoveryStderr: "private-error" },
    { forwardRecoveryOutput: forwardRecoveryReceipt({ skipped: 1 }) },
  ]) {
    const value=harness(tap(),[],["ops/gateway","tools/api-contract-toolchain"],settings);try{
      let receipt;
      assert.throws(()=>withSourceReadToken(sourceReadToken,()=>prepareP2IdentityProbeFixtures({frontendRoot:value.root,nodeVersion:"24.18.0",
        recoveryPostgres18:true,run:value.run,dockerSocketStat:value.dockerSocketStat,makeTemporaryDirectory:()=>value.workspace})),
      error=>{receipt=p2IdentityFixtureFailureReceipt(error);return true;});
      assert.equal(receipt.phase,"recovery-postgres18");assert.equal(receipt.stage,"recovery");
      assert.equal(receipt.recoveryQualification,"forward");assert.equal(receipt.ownedDisposableDatabaseExecutionAttempted,true);
      assert.equal(JSON.stringify(receipt).includes("private-"),false);
      const runs=value.calls.filter(call=>call.file==="docker"&&call.args[0]==="--host");assert.equal(runs.length,2);
      assert.equal(runs[0].args.includes("--forward-brand"),false);assert.equal(runs[1].args.at(-1),"--forward-brand");
    }finally{value.cleanup();}
  }
});

test("failures expose only fixed diagnostic phases and never private child output", () => {
  const scenarios = [
    { phase: "source-fetch", stage: "course", fail: (_file, args, options) =>
      options.cwd.endsWith("lash-her-course-api") && args[0] === "fetch" },
    { phase: "npm-ci", stage: "course", fail: (file, args, options) =>
      file === "npm" && args[0] === "ci" && options.cwd.endsWith("lash-her-course-api") },
    { phase: "build", stage: "course", fail: (file, args, options) =>
      file === "npm" && args[0] === "run" && options.cwd.endsWith("lash-her-course-api") },
    { phase: "exact-source-proof", stage: "course", fail: (file, args, options) =>
      file === "git" && args.join(" ") === "remote get-url origin" && options.cwd.endsWith("lash-her-course-api") },
  ];
  for (const scenario of scenarios) {
    const value = harness();
    try {
      const refusingRun = (file, args, options) => scenario.fail(file, args, options) ?
        { status: 1, signal: null, stdout: "private-child-output", stderr: "private-child-error" } : value.run(file, args, options);
      let receipt;
      assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
        run: refusingRun, makeTemporaryDirectory: () => value.workspace })), error => {
        receipt = p2IdentityFixtureFailureReceipt(error); return true;
      });
      assert.equal(receipt.phase, scenario.phase); assert.equal(receipt.stage, scenario.stage);
      assert.equal(JSON.stringify(receipt).includes("private-child"), false);
    } finally { value.cleanup(); }
  }
  const identity = harness(tap({ pass: 18, skipped: 1 }));
  try {
    let receipt;
    assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: identity.root, nodeVersion: "24.18.0",
      run: identity.run, makeTemporaryDirectory: () => identity.workspace })), error => { receipt = p2IdentityFixtureFailureReceipt(error); return true; });
    assert.equal(receipt.phase, "identity-tests"); assert.equal(receipt.stage, "identity");
  } finally { identity.cleanup(); }
  const recovery = harness(tap(), [], ["ops/gateway", "tools/api-contract-toolchain"], { recoveryOutput: recoveryReceipt({ checks: 14 }) });
  try {
    let receipt;
    assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: recovery.root, nodeVersion: "24.18.0",
      recoveryPostgres18: true, run: recovery.run, dockerSocketStat: recovery.dockerSocketStat, makeTemporaryDirectory: () => recovery.workspace })),
    error => { receipt = p2IdentityFixtureFailureReceipt(error); return true; });
    assert.equal(receipt.phase, "recovery-postgres18"); assert.equal(receipt.stage, "recovery");
    assert.equal(receipt.ownedDisposableDatabaseExecutionAttempted, true);
    assert.equal(receipt.databaseConnected, null); assert.equal(receipt.sqlExecuted, null);
    assert.equal(receipt.recoveryFailure, "receipt-invalid");
    assert.equal(receipt.recoveryQualification, "current");
  } finally { recovery.cleanup(); }
  assert.deepEqual(p2IdentityFixtureFailureReceipt(new Error("private")), { version: 1, status: "P2_IDENTITY_PROBE_FIXTURES_REFUSED",
    phase: "preflight", stage: "frontend", fixtureOnly: true, providerTouched: false, stagingTouched: false,
    databaseConnected: false, sqlExecuted: false, ownedDisposableDatabaseExecutionAttempted: false, releaseAccepted: false });
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
