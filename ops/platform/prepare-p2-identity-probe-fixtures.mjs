// CI-only preparation for the existing owned identity probe fixtures.
// Fetches fixed private API repositories; never accepts a URL, ref or command.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const MANIFEST = "contracts/api-integration/p2-candidate/manifest.json";
const TEST_FILE = "ops/platform/p2-identity-negative-probe.test.mjs";
const RECOVERY_MODE = "--recovery-postgres18";
const RECOVERY_IMAGE = "lash-her-frontend-migration:postgres18-test";
const RECOVERY_PRIVILEGE_FAULTS = Object.freeze([
  "frontend-runtime-inbound", "frontend-runtime-outbound", "frontend-runtime-rogue-admin", "frontend-owner-inbound",
  "frontend-owner-outbound", "frontend-sequence-update", "frontend-default-unexpected-grantee", "frontend-global-default",
  "frontend-table-grant-option", "frontend-default-grant-option", "frontend-table-references", "frontend-table-trigger",
  "frontend-operator-superuser", "frontend-runtime-role-settings", "frontend-runtime-rogue-ownership",
  "frontend-runtime-database-settings", "frontend-runtime-public-schema-access",
  ...["course", "community"].flatMap(service => ["runtime-inbound", "migration-inbound", "runtime-outbound", "sequence-update",
    "table-trigger", "table-references", "default-unexpected-grantee", "default-sequence-update", "global-default", "table-grant-option",
    "default-grant-option"].map(fault => `${service}-${fault}`)),
].sort());
const RECOVERY_ENVIRONMENT_ISOLATION = Object.freeze({ nodeOptionsPositiveControlExecuted: true, poisonedParentEnvironment: true,
  ambientNodeOptionsExecuted: false, ambientConfigVariablesAbsent: true, childEnvironmentAllowlistEnforced: true });
const SOURCE_PATHS = Object.freeze(["src", "scripts", "contracts", "ops", "tests", "openapi", ":(glob).env*", ":(glob)tsconfig*.json"]);
const DEPENDENCY_ROOTS = Object.freeze(["ops/gateway", "tools/api-contract-toolchain"]);
const RECOVERY_MOUNTS = Object.freeze([
  Object.freeze({ source: "ops/platform", target: "/source/ops/platform", kind: "directory" }),
  Object.freeze({ source: "ops/gateway/routes.json", target: "/source/ops/gateway/routes.json", kind: "file" }),
  Object.freeze({ source: "drizzle", target: "/source/drizzle", kind: "directory" }),
  Object.freeze({ source: "node_modules", target: "/source/node_modules", kind: "directory" }),
  Object.freeze({ source: "src", target: "/source/src", kind: "directory" }),
  Object.freeze({ source: "scripts", target: "/source/scripts", kind: "directory" }),
  Object.freeze({ source: "tsconfig.json", target: "/source/tsconfig.json", kind: "file" }),
  Object.freeze({ source: "package.json", target: "/source/package.json", kind: "file" }),
  Object.freeze({ source: "contracts/api-integration/v1", target: "/source/contracts/api-integration/v1", kind: "directory" }),
  Object.freeze({ source: "contracts/api-integration/p2-candidate", target: "/source/contracts/api-integration/p2-candidate", kind: "directory" }),
]);
const REPOSITORIES = Object.freeze({
  course: Object.freeze({
    name: "lash-her-course-api",
    url: "https://github.com/princessdardan/lash-her-course-api.git",
    packageName: "lash-her-course-api",
  }),
  community: Object.freeze({
    name: "lash-her-community-api",
    url: "https://github.com/princessdardan/lash-her-community-api.git",
    packageName: "lash-her-community-api",
  }),
});
const ARTIFACTS = Object.freeze({
  course: Object.freeze({ repository: "lash-her-course-api", sourcePath: "openapi/course-api.json", file: "course-api.json" }),
  community: Object.freeze({ repository: "lash-her-community-api", sourcePath: "openapi/community-api.json", file: "community-api.json" }),
  enrollmentEvent: Object.freeze({ repository: "lash-her-community-api", sourcePath: "contracts/course-enrollment/v1/enrollment-event.schema.json", file: "enrollment-event.schema.json" }),
});
const FAILURE_PHASES = Object.freeze(["preflight", "source-fetch", "npm-ci", "build", "exact-source-proof", "identity-tests",
  "recovery-postgres18", "cleanup"]);
const FAILURE_STAGES = Object.freeze(["frontend", "workspace", "course", "community", "identity", "recovery"]);
const demand = condition => { if (!condition) throw new Error("P2_IDENTITY_FIXTURE_PREPARATION_REFUSED"); };
const digest = (value, length = 64) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value) && !/^0+$/u.test(value);
const hash = value => createHash("sha256").update(value).digest("hex");
const safeRelative = value => typeof value === "string" && value.length <= 200 && /^[A-Za-z0-9_./-]+$/u.test(value) && !value.split("/").includes("..");
const validSourceReadToken = value => typeof value === "string" && value.length >= 20 && value.length <= 512 && !/[\u0000-\u0020\u007f]/u.test(value);
const mark = (diagnostic, phase, stage) => { demand(FAILURE_PHASES.includes(phase) && FAILURE_STAGES.includes(stage)); diagnostic.phase = phase; diagnostic.stage = stage; };

function readBounded(path, maximum = 2_000_000) {
  const info = lstatSync(path);
  demand(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximum);
  return readFileSync(path);
}

export function validateP2IdentityFixtureManifest(raw) {
  const manifest = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw);
  demand(manifest?.version === 1 && manifest.status === "released" && digest(manifest.frontendBaseRevision, 40) &&
    digest(manifest.boundarySha256) && digest(manifest.readmeSha256) && manifest.artifacts && typeof manifest.artifacts === "object" &&
    JSON.stringify(Object.keys(manifest.artifacts).sort()) === JSON.stringify(Object.keys(ARTIFACTS).sort()));
  for (const [name, expected] of Object.entries(ARTIFACTS)) {
    const artifact = manifest.artifacts[name];
    demand(artifact && Object.keys(expected).every(key => artifact[key] === expected[key]) && digest(artifact.revision, 40) &&
      digest(artifact.sha256) && safeRelative(artifact.sourcePath));
  }
  demand(manifest.artifacts.community.revision === manifest.artifacts.enrollmentEvent.revision);
  return manifest;
}

function privateTemporaryDirectory(makeTemporaryDirectory) {
  const directory = realpathSync(makeTemporaryDirectory());
  const info = lstatSync(directory);
  demand(resolve(directory) === directory && info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0);
  for (let path = directory;; path = dirname(path)) {
    demand(!existsSync(join(path, ".git")));
    if (dirname(path) === path) break;
  }
  demand(readdirSync(directory).length === 0);
  return directory;
}

function defaultTemporaryDirectory() {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "lash-p2-identity-fixtures-"));
  chmodSync(directory, 0o700);
  return directory;
}

function defaultRun(file, args, options) {
  return spawnSync(file, args, { cwd: options.cwd, env: options.env, encoding: "utf8", timeout: options.timeout,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function fixedEnvironment(workspace, nodeEnvironment = "development") {
  return Object.freeze({
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    CI: "true",
    LANG: "C",
    LC_ALL: "C",
    NODE_ENV: nodeEnvironment,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_audit: "false",
    npm_config_cache: join(workspace, "npm-cache"),
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_globalconfig: join(workspace, "npm-globalconfig"),
    npm_config_update_notifier: "false",
    npm_config_userconfig: join(workspace, "npm-userconfig"),
  });
}

function sourceFetchEnvironment(environment, sourceReadToken) {
  demand(validSourceReadToken(sourceReadToken));
  const authorization = Buffer.from(`x-access-token:${sourceReadToken}`, "utf8").toString("base64");
  return Object.freeze({ ...environment, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}` });
}

function dockerEnvironment(workspace) {
  const home = join(workspace, "docker-home");
  const configuration = join(workspace, "docker-config");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(configuration, { mode: 0o700 });
  return Object.freeze({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C", HOME: home, DOCKER_CONFIG: configuration });
}

function execute(run, file, args, options) {
  const result = run(file, args, options);
  demand(result && !result.error && result.status === 0 && result.signal == null && typeof result.stdout === "string" && typeof result.stderr === "string");
  return result.stdout;
}

function git(run, directory, args, environment, timeout = 120_000) {
  return execute(run, "git", args, { cwd: directory, env: environment, timeout }).trim();
}

function cleanSource(run, directory, environment) {
  git(run, directory, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--"], environment);
  git(run, directory, ["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--"], environment);
  demand(git(run, directory, ["ls-files", "--others", "--exclude-standard", "-z"], environment) === "");
  const ignored = git(run, directory, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...SOURCE_PATHS], environment)
    .split("\0").filter(Boolean);
  if (ignored.length === 0) return;
  const installedDependencies = DEPENDENCY_ROOTS.filter(path => {
    try { git(run, directory, ["ls-files", "--error-unmatch", "--", `${path}/package-lock.json`], environment); return true; }
    catch { return false; }
  }).map(path => `${path}/node_modules/`);
  demand(ignored.every(path => installedDependencies.some(root => path.startsWith(root)) ||
    (path.split("/").includes("__pycache__") && path.endsWith(".pyc"))));
}

function sourceProof(run, directory, revision, url, environment) {
  demand(git(run, directory, ["remote", "get-url", "origin"], environment) === url);
  demand(git(run, directory, ["rev-parse", "HEAD"], environment) === revision);
  const tree = git(run, directory, ["rev-parse", "HEAD^{tree}"], environment);
  demand(digest(tree, 40));
  cleanSource(run, directory, environment);
  return tree;
}

function verifyApiSourceForMount(run, directory, revision, definition, environment, sourceReadToken) {
  sourceProof(run, directory, revision, definition.url, environment);
  const configPath = join(directory, ".git/config");
  const info = lstatSync(configPath);
  const configuration = readBounded(configPath, 64_000).toString("utf8");
  demand((info.mode & 0o022) === 0 && !configuration.includes(sourceReadToken) &&
    !/authorization|extraheader|credential/iu.test(configuration));
}

function makeApiSourceMountable(directory) {
  chmodSync(directory, 0o755);
  demand((lstatSync(directory).mode & 0o777) === 0o755);
}

function mount(source, target, kind, boundary) {
  const sourceInfo = lstatSync(source);
  demand(!sourceInfo.isSymbolicLink());
  const path = realpathSync(source);
  const root = realpathSync(boundary);
  const info = lstatSync(path);
  demand((path === root || path.startsWith(root + "/")) && !path.includes(",") && !info.isSymbolicLink() &&
    (kind === "directory" ? info.isDirectory() : info.isFile()));
  return `type=bind,src=${path},dst=${target},readonly`;
}

function recoveryDockerArguments(frontendRoot, directories) {
  for (const file of ["ops/platform/test-p2-recovery-owned.py", "ops/platform/test-p2-recovery-owned.mjs"]) readBounded(join(frontendRoot, file), 1_000_000);
  const mounts = RECOVERY_MOUNTS.map(({ source, target, kind }) => mount(join(frontendRoot, source), target, kind, frontendRoot));
  mounts.push(mount(directories.course, "/exact-sources/lash-her-course-api", "directory", directories.course));
  mounts.push(mount(directories.community, "/exact-sources/lash-her-community-api", "directory", directories.community));
  return ["run", "--rm", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--memory=1g", "--pids-limit=256", "--shm-size=256m", "--tmpfs=/tmp:rw,nosuid,nodev,size=512m,mode=1777", "--workdir=/source",
    "--env=PG_BIN=/usr/lib/postgresql/18/bin", "--env=OWNED_POSTGRES_MAJOR=18", "--env=P2_RECOVERY_OWNED_TEST=true",
    "--env=NODE_BIN=/usr/local/bin/node", "--env=COURSE_RECOVERY_SOURCE_ROOT=/exact-sources/lash-her-course-api",
    "--env=COMMUNITY_RECOVERY_SOURCE_ROOT=/exact-sources/lash-her-community-api", ...mounts.flatMap(value => ["--mount", value]),
    "--entrypoint=python3", RECOVERY_IMAGE, "ops/platform/test-p2-recovery-owned.py"];
}

export function parseP2RecoveryPostgres18Receipt(output) {
  demand(typeof output === "string" && output.length > 0 && output.length <= 1_000_000);
  const lines = output.trim().split("\n");
  demand(lines.length === 1);
  const receipt = JSON.parse(lines[0]);
  const isolation = receipt?.environmentIsolation;
  const isolationMatches = isolation && JSON.stringify(Object.keys(isolation).sort()) ===
    JSON.stringify(Object.keys(RECOVERY_ENVIRONMENT_ISOLATION).sort()) &&
    Object.entries(RECOVERY_ENVIRONMENT_ISOLATION).every(([name, expected]) => isolation[name] === expected);
  demand(receipt?.status === "OWNED_P2_RECOVERY_DATABASE_CHECKS_PASS" && receipt.serverMajor === 18 &&
    receipt.frontendMigrations === 83 && receipt.courseMigrations === 22 && receipt.communityMigrations === 11 &&
    receipt.checks === 55 && receipt.skipped === 0 && receipt.fixtureOnly === true && receipt.providerTouched === false &&
    receipt.frontendInitialPrivilegeRefusals === 17 && receipt.frontendContinuousPrivilegeRefusals === 17 &&
    receipt.apiPrivilegeRefusals === 22 && receipt.legacyApiVerifierRefusals === 2 && receipt.frontendCreatorMemberships === 3 &&
    receipt.frontendOperatorSearchPathPinned === true &&
    receipt.frontendCreatorPolicy === "actual-non-superuser-automatic-admin-plus-explicit-owner-set" &&
    JSON.stringify(receipt.privilegeFaults) === JSON.stringify(RECOVERY_PRIVILEGE_FAULTS) &&
    isolationMatches &&
    receipt.noSqlReplay === true && receipt.originalFrontendTerminalRecreated === false);
  return receipt;
}

function validatePackage(directory, definition) {
  const packageBytes = readBounded(join(directory, "package.json"), 256_000);
  const lockBytes = readBounded(join(directory, "package-lock.json"), 2_000_000);
  const packageDocument = JSON.parse(packageBytes.toString("utf8"));
  const lock = JSON.parse(lockBytes.toString("utf8"));
  demand(packageDocument.name === definition.packageName && packageDocument.scripts?.["build:production"] === "tsc -p tsconfig.build.json" && lock.lockfileVersion === 3);
  return { packageSha256: hash(packageBytes), packageLockSha256: hash(lockBytes) };
}

function verifyArtifacts(directory, manifest, repository) {
  const proofs = {};
  for (const [name, artifact] of Object.entries(manifest.artifacts).filter(([, value]) => value.repository === repository)) {
    const bytes = readBounded(join(directory, artifact.sourcePath));
    demand(hash(bytes) === artifact.sha256);
    proofs[name] = artifact.sha256;
  }
  demand(Object.keys(proofs).length > 0);
  return proofs;
}

export function parseP2IdentityProbeTap(output) {
  const fields = {};
  for (const name of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const matches = [...output.matchAll(new RegExp(`^# ${name} ([0-9]+)$`, "gmu"))];
    demand(matches.length === 1);
    fields[name] = Number(matches[0][1]);
  }
  demand(fields.tests === 19 && fields.pass === 19 && fields.fail === 0 && fields.cancelled === 0 && fields.skipped === 0 && fields.todo === 0);
  return fields;
}

function prepareP2IdentityProbeFixturesInternal(options, diagnostic) {
  mark(diagnostic, "preflight", "frontend");
  const frontendRoot = realpathSync(options.frontendRoot ?? ROOT);
  const run = options.run ?? defaultRun;
  const makeTemporaryDirectory = options.makeTemporaryDirectory ?? defaultTemporaryDirectory;
  const sourceReadToken = process.env.PLATFORM_SOURCE_READ_TOKEN;
  demand(typeof run === "function" && typeof makeTemporaryDirectory === "function" &&
    [undefined, true, false].includes(options.recoveryPostgres18) && Number((options.nodeVersion ?? process.versions.node).split(".")[0]) === 24);
  demand(validSourceReadToken(sourceReadToken));
  const manifestBytes = readBounded(join(frontendRoot, MANIFEST), 512_000);
  const manifest = validateP2IdentityFixtureManifest(manifestBytes);
  let workspace;
  let failed = false;
  try {
    mark(diagnostic, "preflight", "workspace");
    workspace = privateTemporaryDirectory(makeTemporaryDirectory);
    mkdirSync(join(workspace, "npm-cache"), { mode: 0o700 });
    writeFileSync(join(workspace, "npm-globalconfig"), "", { flag: "wx", mode: 0o600 });
    writeFileSync(join(workspace, "npm-userconfig"), "", { flag: "wx", mode: 0o600 });
    const installEnvironment = fixedEnvironment(workspace, "development");
    const buildEnvironment = fixedEnvironment(workspace, "production");
    mark(diagnostic, "exact-source-proof", "frontend");
    const frontendCommit = git(run, frontendRoot, ["rev-parse", "HEAD"], installEnvironment);
    demand(digest(frontendCommit, 40));
    cleanSource(run, frontendRoot, installEnvironment);
    const npmVersion = execute(run, "npm", ["--version"], { cwd: frontendRoot, env: installEnvironment, timeout: 30_000 }).trim();
    demand(/^11\.[0-9]+\.[0-9]+$/u.test(npmVersion));
    const sources = {};
    const directories = {};
    for (const [service, definition] of Object.entries(REPOSITORIES)) {
      mark(diagnostic, "source-fetch", service);
      const revision = manifest.artifacts[service].revision;
      const directory = join(workspace, definition.name);
      mkdirSync(directory, { mode: 0o700 });
      git(run, directory, ["init", "--quiet", "."], installEnvironment);
      git(run, directory, ["remote", "add", "origin", definition.url], installEnvironment);
      git(run, directory, ["fetch", "--no-tags", "--depth=1", "origin", revision], sourceFetchEnvironment(installEnvironment, sourceReadToken), 180_000);
      git(run, directory, ["-c", "advice.detachedHead=false", "checkout", "--detach", "--force", "FETCH_HEAD"], installEnvironment);
      mark(diagnostic, "exact-source-proof", service);
      const gitTree = sourceProof(run, directory, revision, definition.url, installEnvironment);
      const packageProof = validatePackage(directory, definition);
      const artifactSha256 = verifyArtifacts(directory, manifest, definition.name);
      mark(diagnostic, "npm-ci", service);
      execute(run, "npm", ["ci", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"],
        { cwd: directory, env: installEnvironment, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
      mark(diagnostic, "build", service);
      execute(run, "npm", ["run", "build:production"],
        { cwd: directory, env: buildEnvironment, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
      mark(diagnostic, "exact-source-proof", service);
      sourceProof(run, directory, revision, definition.url, installEnvironment);
      sources[service] = { repository: definition.name, revision, gitTree, ...packageProof, artifactSha256 };
      directories[service] = directory;
    }
    const testEnvironment = { ...fixedEnvironment(workspace, "test"),
      P2_IDENTITY_COURSE_RUNTIME_DIR: directories.course,
      P2_IDENTITY_COMMUNITY_RUNTIME_DIR: directories.community };
    mark(diagnostic, "identity-tests", "identity");
    const output = execute(run, process.execPath, ["--test", "--test-reporter=tap", TEST_FILE],
      { cwd: frontendRoot, env: testEnvironment, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
    const tests = parseP2IdentityProbeTap(output);
    let recovery;
    if (options.recoveryPostgres18 === true) {
      mark(diagnostic, "recovery-postgres18", "recovery");
      for (const [service, definition] of Object.entries(REPOSITORIES))
        verifyApiSourceForMount(run, directories[service], manifest.artifacts[service].revision, definition, installEnvironment, sourceReadToken);
      for (const directory of Object.values(directories)) makeApiSourceMountable(directory);
      diagnostic.recoveryStarted = true;
      const recoveryOutput = execute(run, "docker", recoveryDockerArguments(frontendRoot, directories),
        { cwd: frontendRoot, env: dockerEnvironment(workspace), timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
      const receipt = parseP2RecoveryPostgres18Receipt(recoveryOutput);
      recovery = { status: receipt.status, serverMajor: receipt.serverMajor, frontendMigrations: receipt.frontendMigrations,
        courseMigrations: receipt.courseMigrations, communityMigrations: receipt.communityMigrations, skipped: receipt.skipped,
        fixtureOnly: receipt.fixtureOnly, providerTouched: receipt.providerTouched, checks: receipt.checks,
        privilegeFaults: receipt.privilegeFaults, frontendInitialPrivilegeRefusals: receipt.frontendInitialPrivilegeRefusals,
        frontendContinuousPrivilegeRefusals: receipt.frontendContinuousPrivilegeRefusals, apiPrivilegeRefusals: receipt.apiPrivilegeRefusals,
        legacyApiVerifierRefusals: receipt.legacyApiVerifierRefusals, frontendCreatorPolicy: receipt.frontendCreatorPolicy,
        frontendCreatorMemberships: receipt.frontendCreatorMemberships,
        frontendOperatorSearchPathPinned: receipt.frontendOperatorSearchPathPinned, environmentIsolation: receipt.environmentIsolation,
        noSqlReplay: receipt.noSqlReplay, originalFrontendTerminalRecreated: receipt.originalFrontendTerminalRecreated };
    }
    mark(diagnostic, "exact-source-proof", "frontend");
    cleanSource(run, frontendRoot, installEnvironment);
    return { version: 1, status: recovery ? "P2_IDENTITY_AND_RECOVERY_FIXTURES_PASS" : "P2_IDENTITY_PROBE_FIXTURES_PASS", frontendSourceCommit: frontendCommit,
      manifestSha256: hash(manifestBytes), nodeMajor: 24, npmMajor: 11, sources, tests,
      ...(recovery ? { recovery } : {}),
      skipped: tests.skipped + (recovery?.skipped ?? 0), fixtureOnly: true, privateSourceFetch: true,
      fetchCredentialForwardedBeyondGit: false, scriptsIgnoredDuringInstall: true, providerTouched: false,
      stagingTouched: false, databaseConnected: recovery !== undefined, sqlExecuted: recovery !== undefined,
      ownedDisposableDatabase: recovery !== undefined, releaseAccepted: false };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (workspace !== undefined) {
      if (!failed) mark(diagnostic, "cleanup", "workspace");
      const prefix = join(realpathSync(tmpdir()), "lash-p2-identity-fixtures-");
      demand(workspace.startsWith(prefix) || options.makeTemporaryDirectory !== undefined);
      rmSync(workspace, { recursive: true, force: true });
    }
  }
}

export function prepareP2IdentityProbeFixtures(options = {}) {
  const diagnostic = { phase: "preflight", stage: "frontend" };
  try { return prepareP2IdentityProbeFixturesInternal(options, diagnostic); }
  catch {
    const error = new Error("P2_IDENTITY_FIXTURE_PREPARATION_REFUSED");
    Object.defineProperties(error, { phase: { value: diagnostic.phase }, stage: { value: diagnostic.stage },
      recoveryStarted: { value: diagnostic.recoveryStarted === true } });
    throw error;
  }
}

export function p2IdentityFixtureFailureReceipt(error) {
  const phase = FAILURE_PHASES.includes(error?.phase) ? error.phase : "preflight";
  const stage = FAILURE_STAGES.includes(error?.stage) ? error.stage : "frontend";
  const recoveryStarted = error?.recoveryStarted === true;
  return { version: 1, status: "P2_IDENTITY_PROBE_FIXTURES_REFUSED", phase, stage, fixtureOnly: true, providerTouched: false,
    stagingTouched: false, databaseConnected: recoveryStarted ? null : false, sqlExecuted: recoveryStarted ? null : false,
    ownedDisposableDatabaseExecutionAttempted: recoveryStarted, releaseAccepted: false };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    demand(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === RECOVERY_MODE));
    process.stdout.write(JSON.stringify(prepareP2IdentityProbeFixtures({ recoveryPostgres18: process.argv[2] === RECOVERY_MODE })) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify(p2IdentityFixtureFailureReceipt(error)) + "\n");
    process.exitCode = 1;
  }
}
