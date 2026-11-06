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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  P2_LIFECYCLE_OWNED_API_REVISIONS,
  P2_INTERRUPTED_OWNED_SOURCE_FILES,
  P2_KNOWN_ACK_OWNED_SOURCE_FILES,
  p2LifecycleOwnedSourceFileMap,
  verifyP2LifecycleOwnedSourceManifest,
} from "./p2-lifecycle-owned-source-manifest.mjs";

const ROOT = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const MANIFEST = "contracts/api-integration/p2-candidate/manifest.json";
const TEST_FILE = "ops/platform/p2-identity-negative-probe.test.mjs";
const RECOVERY_MODE = "--recovery-postgres18";
const LIFECYCLE_MODE = "--lifecycle-postgres18";
const RECOVERY_IMAGE = "lash-her-frontend-migration:postgres18-test";
const INTERRUPTED_ENTRY = "docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs";
const INTERRUPTED_HELPERS = P2_INTERRUPTED_OWNED_SOURCE_FILES.filter(name => name.startsWith("docs/"));
const INTERRUPTED_SERVICES = Object.freeze(["community-api", "course-api", "community-tls", "course-tls", "course-snapshot",
  "community-worker", "course-media", "course-export-cleanup", "course-publisher", "gateway"]);
const INTERRUPTED_BOUNDARIES = Object.freeze(["private-application-credential-required", "private-community-peer-denied",
  "private-course-tls-catalog", "public-metrics-hidden", "public-tls-missing-workload-denied"]);
const FRONTEND_REPOSITORY = Object.freeze({ name: "lash-her-frontend", url: "https://github.com/princessdardan/lash-her-frontend.git" });
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
const FORWARD_RECOVERY_CHECKS = Object.freeze([
  "actual-fe-physical-session", "both-api-current-readonly", "actual-tls-build-probe-promote", "same-source-candidate-new-action",
  "real-opaque-scope-shared-observer", "selected-workload-bytes", "cloned-plain-scope-refused", "wrong-client-verifier-refused",
  "wrong-plan-candidate-target-directory-refused", "wrong-inventory-action-refused", "shared-mutation-operations-refused",
  "receipt-drift-refused", "expired-session-refused", "open-admission-mutation-refused", "opened-admission-get-retained",
  "original-terminal-retained-not-current", "original-receipts-preserved",
  "actual-runtime-credential-tls-physical-binding", "bad-runtime-credential-and-foreign-physical-refused",
]);
const FORWARD_RECOVERY_RECEIPT_KEYS = Object.freeze([
  "actualRuntimeContainers", "checks", "communityMigrations", "courseMigrations", "environmentIsolation", "fixtureOnly",
  "foreignRuntimeTlsAuthenticated", "frontendMigrations", "journalDigestsUnchanged", "mutationRefusals", "noSqlReplay", "originalFrontendTerminalRecreated",
  "providerTouched", "runtimeCredentialFaultProviderCalls", "runtimeCredentialRefusals", "serverMajor", "skipped", "status",
].sort());
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
const LIFECYCLE_FRONTEND_MOUNTS = Object.freeze([
  Object.freeze({ source: "ops/platform", target: "/source/ops/platform", kind: "directory" }),
  Object.freeze({ source: "drizzle", target: "/source/drizzle", kind: "directory" }),
  Object.freeze({ source: "node_modules", target: "/source/node_modules", kind: "directory" }),
  Object.freeze({ source: "src", target: "/source/src", kind: "directory" }),
  Object.freeze({ source: "scripts", target: "/source/scripts", kind: "directory" }),
  Object.freeze({ source: "package.json", target: "/source/package.json", kind: "file" }),
  Object.freeze({ source: "package-lock.json", target: "/source/package-lock.json", kind: "file" }),
  Object.freeze({ source: "contracts/api-integration/v1", target: "/source/contracts/api-integration/v1", kind: "directory" }),
  Object.freeze({ source: "contracts/api-integration/p2-candidate", target: "/source/contracts/api-integration/p2-candidate", kind: "directory" }),
]);
const LIFECYCLE_API_MOUNTS = Object.freeze([
  Object.freeze({ source: "drizzle", kind: "directory" }), Object.freeze({ source: "src", kind: "directory" }),
  Object.freeze({ source: "dist", kind: "directory" }), Object.freeze({ source: "openapi", kind: "directory" }),
  Object.freeze({ source: "contracts", kind: "directory" }), Object.freeze({ source: "node_modules", kind: "directory" }),
  Object.freeze({ source: "package.json", kind: "file" }), Object.freeze({ source: "package-lock.json", kind: "file" }),
]);
const LIFECYCLE_CHECKS = Object.freeze([
  "actual-three-domain-export-ready-observed", "actual-24-hour-schema-bound-export-scrub-observed",
  "actual-delete-field-removal-and-retention-observed", "wrong-original-email-refused", "missing-receiver-ack-refused",
  "identified-attempt-refused", "retained-community-export-refused", "common-output-private-values-absent",
  "requested-command-version-refused", "unlisted-account-attempt-refused", "expired-ready-export-refused",
  "missing-export-history-refused", "cross-bound-prior-refused",
]);
const LIFECYCLE_RECEIVER_CHECKS = Object.freeze([
  "actual-source-both-receivers-accept-canonical-suspend-over-verified-tls",
  ...["course", "community"].flatMap(service => ["exact-replay", "changed-replay", "stale-restore", "future-gap"]
    .map(caseName => `${service}-${caseName}-actual-status-and-three-domain-unchanged`)),
  "actual-durable-quotas-write-with-account-domain-digests-unchanged",
  "actual-unauthorized-responses-cannot-qualify-negative-case",
  "actual-terminal-delete-refuses-restore-and-preserves-exact-old-replay",
]);
const LIFECYCLE_SOURCE_FILES = Object.freeze([
  "p2-lifecycle-state-witness.mjs", "p2-lifecycle-persistence-probe.mjs", "p2-lifecycle-owned-source-manifest.mjs",
  "harness/owned-p2-lifecycle-persistence.mjs", "test-p2-lifecycle-persistence-local.mjs",
]);
const LIFECYCLE_RECEIPT_KEYS = Object.freeze([
  "checks", "communityMigrations", "courseMigrations", "fixtureOnly", "frontendMigrations", "liveCertification",
  "postgresMajor", "providerTouched", "readOnly", "skipped", "sourceCommits", "sourceManifestSha256", "sourceMode",
  "sourceSha256", "status", "version",
].sort());
const LIFECYCLE_RECEIVER_SOURCE_FILES = Object.freeze([
  "p2-lifecycle-state-witness.mjs", "p2-lifecycle-persistence-probe.mjs", "p2-lifecycle-receiver-post.mjs",
  "p2-lifecycle-owned-source-manifest.mjs", "p2-lifecycle-receiver-negatives.mjs",
  "harness/owned-p2-lifecycle-receivers.mjs", "test-p2-lifecycle-receivers-local.mjs",
]);
const LIFECYCLE_RECEIVER_RECEIPT_KEYS = Object.freeze([
  "checks", "communityMigrations", "courseMigrations", "deployedFutureGapQualified", "domainStatePreserving",
  "fixtureOnly", "frontendMigrations", "globallyReadOnly", "hostDockerPathQualified", "httpCaseCount", "liveCertification",
  "postgresMajor", "providerTouched", "quotaWritesObserved", "skipped", "sourceCommits", "sourceManifestSha256",
  "sourceMode", "sourceSha256", "status", "version",
].sort());
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
  "recovery-postgres18", "lifecycle-postgres18", "cleanup"]);
const FAILURE_STAGES = Object.freeze(["frontend", "workspace", "course", "community", "identity", "recovery", "lifecycle", "receivers", "interrupted-restoration", "interrupted-negatives"]);
const RECOVERY_FAILURES = Object.freeze(["docker-transport", "child-exit", "receipt-invalid"]);
const RECOVERY_QUALIFICATIONS = Object.freeze(["current", "forward", "persistence", "receivers", "interrupted-restoration", "interrupted-negatives"]);
const PRIVATE_FAILURE_DIRECTORY = "p2-owned-fixture-failure";
const PRIVATE_FAILURE_MAX_BYTES = 4 * 1024 * 1024;
const demand = condition => { if (!condition) throw new Error("P2_IDENTITY_FIXTURE_PREPARATION_REFUSED"); };
const digest = (value, length = 64) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value) && !/^0+$/u.test(value);
const hash = value => createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : child);
const exactKeys = (value, keys) => Boolean(value && typeof value === "object" && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
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

function privateFailureDirectory(qualification, sourceCommit) {
  demand(RECOVERY_QUALIFICATIONS.includes(qualification) && digest(sourceCommit, 40));
  const runnerTemporary = process.env.RUNNER_TEMP;
  demand(typeof runnerTemporary === "string" && resolve(runnerTemporary) === runnerTemporary && !/[\u0000-\u001f\u007f]/u.test(runnerTemporary));
  const runnerInfo = lstatSync(runnerTemporary), runnerRoot = realpathSync(runnerTemporary);
  demand(runnerInfo.isDirectory() && !runnerInfo.isSymbolicLink() && runnerInfo.uid === process.getuid());
  const root = join(runnerRoot, PRIVATE_FAILURE_DIRECTORY);
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  const rootInfo = lstatSync(root);
  demand(rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && rootInfo.uid === process.getuid() && (rootInfo.mode & 0o077) === 0);
  const directory = join(root, qualification);
  mkdirSync(directory, { mode: 0o700 });
  const info = lstatSync(directory);
  demand(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0);
  return { directory, sourceCommit };
}

function retainPrivateDockerFailure(qualification, sourceCommit, failure, result) {
  demand(RECOVERY_FAILURES.includes(failure));
  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  const stderr = typeof result?.stderr === "string" ? result.stderr : "";
  const rawStdout = Buffer.from(stdout), rawStderr = Buffer.from(stderr);
  const storedStdout = rawStdout.subarray(0, PRIVATE_FAILURE_MAX_BYTES), storedStderr = rawStderr.subarray(0, PRIVATE_FAILURE_MAX_BYTES);
  const target = privateFailureDirectory(qualification, sourceCommit);
  const signal = typeof result?.signal === "string" && /^SIG[A-Z0-9]{1,16}$/u.test(result.signal) ? result.signal : null;
  const metadata = { version: 1, status: "P2_OWNED_FIXTURE_PRIVATE_FAILURE", qualification, sourceCommit, failure,
    exitStatus: Number.isInteger(result?.status) ? result.status : null, signal, spawnError: result?.error != null,
    stdoutBytes: storedStdout.length, stderrBytes: storedStderr.length,
    stdoutTruncated: rawStdout.length > storedStdout.length, stderrTruncated: rawStderr.length > storedStderr.length };
  writeFileSync(join(target.directory, `${target.sourceCommit}.stdout.log`), storedStdout, { flag: "wx", mode: 0o600 });
  writeFileSync(join(target.directory, `${target.sourceCommit}.stderr.log`), storedStderr, { flag: "wx", mode: 0o600 });
  writeFileSync(join(target.directory, `${target.sourceCommit}.json`), canonical(metadata) + "\n", { flag: "wx", mode: 0o600 });
  for (const suffix of ["stdout.log", "stderr.log", "json"])
    demand((lstatSync(join(target.directory, `${target.sourceCommit}.${suffix}`)).mode & 0o077) === 0);
}

function defaultRun(file, args, options) {
  return spawnSync(file, args, { cwd: options.cwd, env: options.env, encoding: "utf8", timeout: options.timeout,
    input: options.input, maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
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

function dockerContextEnvironment() {
  const home = process.env.HOME;
  demand(typeof home === "string" && resolve(home) === home && !/[\u0000-\u001f\u007f]/u.test(home));
  return Object.freeze({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C", HOME: home });
}

export function parseP2DockerContextEndpoint(output, socketStat = lstatSync) {
  demand(typeof output === "string" && output.length > 0 && output.length <= 2_048 && typeof socketStat === "function");
  const endpoint = JSON.parse(output.trim());
  demand(typeof endpoint === "string" && endpoint.length <= 1_024 && /^unix:\/\/[A-Za-z0-9_./-]+$/u.test(endpoint));
  const socketPath = endpoint.slice("unix://".length);
  demand(resolve(socketPath) === socketPath && !socketPath.split("/").includes(".."));
  const info = socketStat(socketPath);
  demand(info && info.isSocket() && !info.isSymbolicLink());
  return endpoint;
}

function currentDockerContextEndpoint(run, socketStat, cwd) {
  const result = run("docker", ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
    { cwd, env: dockerContextEnvironment(), timeout: 30_000, maxBuffer: 64 * 1024 });
  demand(result && !result.error && result.status === 0 && result.signal == null && typeof result.stdout === "string" &&
    typeof result.stderr === "string");
  return parseP2DockerContextEndpoint(result.stdout, socketStat);
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
  const remote = git(run, directory, ["remote", "get-url", "origin"], environment);
  demand(remote === url || (url === FRONTEND_REPOSITORY.url && remote === "https://github.com/princessdardan/lash-her-frontend"));
  demand(git(run, directory, ["rev-parse", "HEAD"], environment) === revision);
  const tree = git(run, directory, ["rev-parse", "HEAD^{tree}"], environment);
  demand(digest(tree, 40));
  cleanSource(run, directory, environment);
  return tree;
}

export function verifyP2FrontendSourceProof(run, directory, revision, environment) {
  demand(typeof run === "function" && typeof directory === "string" && digest(revision, 40) && environment && typeof environment === "object");
  return Object.freeze({ repository: FRONTEND_REPOSITORY.url,
    gitTree: sourceProof(run, directory, revision, FRONTEND_REPOSITORY.url, environment) });
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

function forwardRecoveryDockerArguments(frontendRoot, directories) {
  return [...recoveryDockerArguments(frontendRoot, directories), "--forward-brand"];
}

function lifecyclePersistenceDockerArguments(frontendRoot, directories) {
  for (const file of ["ops/platform/test-p2-lifecycle-persistence-local.mjs", "ops/platform/p2-lifecycle-owned-source-manifest.mjs"])
    readBounded(join(frontendRoot, file), 1_000_000);
  const mounts = LIFECYCLE_FRONTEND_MOUNTS.map(({ source, target, kind }) => mount(join(frontendRoot, source), target, kind, frontendRoot));
  for (const [service, directory] of Object.entries(directories)) {
    const targetRoot = `/exact-sources/lash-her-${service}-api`;
    for (const { source, kind } of LIFECYCLE_API_MOUNTS)
      mounts.push(mount(join(directory, source), `${targetRoot}/${source}`, kind, directory));
  }
  return ["run", "--rm", "-i", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--memory=1g", "--pids-limit=256", "--shm-size=256m", "--tmpfs=/tmp:rw,nosuid,nodev,size=512m,mode=1777", "--workdir=/source",
    "--env=PG_BIN=/usr/lib/postgresql/18/bin", "--env=OWNED_POSTGRES_MAJOR=18", "--env=P2_LIFECYCLE_PERSISTENCE_OWNED_TEST=true",
    ...mounts.flatMap(value => ["--mount", value]), "--entrypoint=/usr/local/bin/node", RECOVERY_IMAGE, "--import", "tsx",
    "ops/platform/test-p2-lifecycle-persistence-local.mjs", "--postgres18-manifest"];
}

function lifecycleReceiversDockerArguments(frontendRoot, directories) {
  for (const file of ["ops/platform/test-p2-lifecycle-receivers-local.mjs", "ops/platform/p2-lifecycle-owned-source-manifest.mjs"])
    readBounded(join(frontendRoot, file), 1_000_000);
  const mounts = LIFECYCLE_FRONTEND_MOUNTS.map(({ source, target, kind }) => mount(join(frontendRoot, source), target, kind, frontendRoot));
  for (const [service, directory] of Object.entries(directories)) {
    const targetRoot = `/exact-sources/lash-her-${service}-api`;
    for (const { source, kind } of LIFECYCLE_API_MOUNTS)
      mounts.push(mount(join(directory, source), `${targetRoot}/${source}`, kind, directory));
  }
  return ["run", "--rm", "-i", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--memory=1g", "--pids-limit=256", "--shm-size=256m", "--tmpfs=/tmp:rw,nosuid,nodev,size=512m,mode=1777", "--workdir=/source",
    "--env=PG_BIN=/usr/lib/postgresql/18/bin", "--env=OWNED_POSTGRES_MAJOR=18", "--env=P2_LIFECYCLE_RECEIVER_OWNED_TEST=true",
    ...mounts.flatMap(value => ["--mount", value]), "--entrypoint=/usr/local/bin/node", RECOVERY_IMAGE, "--import", "tsx",
    "ops/platform/test-p2-lifecycle-receivers-local.mjs", "--postgres18-manifest"];
}

function interruptedRestorationDockerArguments(frontendRoot, directories) {
  const frontend = [...LIFECYCLE_FRONTEND_MOUNTS.filter(value => value.source !== "ops/platform"),
    { source: ".git", target: "/source/.git", kind: "directory" },
    { source: "ops", target: "/source/ops", kind: "directory" },
    { source: "tsconfig.json", target: "/source/tsconfig.json", kind: "file" },
    ...INTERRUPTED_HELPERS.map(source => ({ source, target: `/source/${source}`, kind: "file" }))];
  const mounts = frontend.map(({ source, target, kind }) => mount(join(frontendRoot, source), target, kind, frontendRoot));
  for (const [service, directory] of Object.entries(directories))
    mounts.push(mount(directory, `/exact-sources/lash-her-${service}-api`, "directory", directory));
  return ["run", "--rm", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--memory=1g", "--pids-limit=256", "--shm-size=256m", "--tmpfs=/tmp:rw,nosuid,nodev,size=512m,mode=1777", "--workdir=/source",
    "--env=PG_BIN=/usr/lib/postgresql/18/bin", "--env=OWNED_POSTGRES_MAJOR=18", "--env=P2_INTERRUPTED_OWNED_TEST=true",
    "--env=P2_KNOWN_ACK_COURSE_SOURCE_ROOT=/exact-sources/lash-her-course-api",
    "--env=P2_KNOWN_ACK_COMMUNITY_SOURCE_ROOT=/exact-sources/lash-her-community-api",
    ...mounts.flatMap(value => ["--mount", value]), "--entrypoint=/usr/local/bin/node", RECOVERY_IMAGE, "--import", "tsx", INTERRUPTED_ENTRY];
}

function interruptedNegativesDockerArguments(frontendRoot, directories) {
  return [...interruptedRestorationDockerArguments(frontendRoot, directories), "--negative-cases"];
}

export function buildP2InterruptedRestorationExpected(frontendRoot, frontendSource, sources) {
  demand(digest(frontendSource?.revision, 40) && exactKeys(sources, ["course", "community"]));
  const ownedSourceSha256 = Object.fromEntries(P2_INTERRUPTED_OWNED_SOURCE_FILES.map(name => [name, hash(readBounded(join(frontendRoot, name)))]));
  const fixtureSourceSha256 = Object.fromEntries(P2_KNOWN_ACK_OWNED_SOURCE_FILES.map(name =>
    [name, hash(readBounded(join(frontendRoot, "ops/platform", name)))]));
  const gateway = join(frontendRoot, "ops/gateway"), packagePath = join(gateway, "node_modules/jose/package.json");
  const gatewayRequire = createRequire(join(gateway, "package.json"));
  demand(realpathSync(gatewayRequire.resolve("jose/package.json")) === packagePath &&
    realpathSync(gatewayRequire.resolve("jose")).startsWith(join(gateway, "node_modules/jose") + "/"));
  const packageBytes = readBounded(packagePath, 256_000), definition = JSON.parse(readBounded(join(gateway, "package.json"))),
    lock = JSON.parse(readBounded(join(gateway, "package-lock.json")));
  demand(JSON.parse(packageBytes).name === "jose" && JSON.parse(packageBytes).version === "6.2.3" &&
    definition.dependencies?.jose === "6.2.3" && lock.lockfileVersion === 3 && lock.packages?.["node_modules/jose"]?.version === "6.2.3");
  const candidate = { version: 2, environment: "staging", contractPhase: "p2", phase2ContractManifestSha256: "sha256:" + "d".repeat(64),
    releaseId: "owned-known-ack", workload: { projectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM", environment: "production" },
    sources: { frontend: { commit: frontendSource.revision, repository: FRONTEND_REPOSITORY.url, requiredChecks: "passed" } }, artifacts: {},
    runtime: { composeSha256: "sha256:" + hash(readBounded(join(frontendRoot, "ops/platform/compose.yaml"))) } };
  ["gateway", "frontendMigration", "courseMigration", "courseRuntime", "communityMigration", "communityRuntime"].forEach((name, index) => {
    candidate.artifacts[name] = { image: `ghcr.io/princessdardan/owned-${name.toLowerCase()}@sha256:${String(index + 1).repeat(64)}` };
  });
  return { frontendSourceCommit: frontendSource.revision,
    apiSourceCommits: Object.fromEntries(["course", "community"].map(service => [service, sources[service].revision])),
    apiSourceLocks: Object.fromEntries(["course", "community"].map(service => [service, sources[service].packageLockSha256])),
    ownedSourceSha256, fixtureSourceSha256, candidate,
    gatewayDependency: { package: "jose", version: "6.2.3", resolution: "ops/gateway/node_modules/jose", packageSha256: hash(packageBytes) } };
}

export function buildP2LifecyclePersistencePostgres18Input(input) {
  demand(exactKeys(input, ["frontendRoot", "directories", "frontendSource", "sources", "identityManifestSha256", "currentReceipt", "forwardReceipt"])
    && exactKeys(input.directories, ["course", "community"]) && exactKeys(input.sources, ["course", "community"])
    && input.sources.course.revision === P2_LIFECYCLE_OWNED_API_REVISIONS.course &&
    input.sources.community.revision === P2_LIFECYCLE_OWNED_API_REVISIONS.community &&
    digest(input.identityManifestSha256) && typeof input.currentReceipt === "string" && typeof input.forwardReceipt === "string");
  const roots = { frontend: input.frontendRoot, course: input.directories.course, community: input.directories.community };
  const files = Object.fromEntries(Object.entries(roots).map(([service, directory]) =>
    [service, p2LifecycleOwnedSourceFileMap(service, directory)]));
  const sourceMetadata = { frontend: input.frontendSource, course: input.sources.course, community: input.sources.community };
  const manifestSources = Object.fromEntries(Object.entries(sourceMetadata).map(([service, source]) => {
    demand(exactKeys(source, ["repository", "revision", "gitTree", "packageSha256", "packageLockSha256", "artifactSha256"]));
    return [service, { ...structuredClone(source), files: files[service] }];
  }));
  const parentProof = { version: 1, status: "P2_LIFECYCLE_PERSISTENCE_PARENT_PROOF", identityManifestSha256: input.identityManifestSha256,
    currentReceiptSha256: hash(input.currentReceipt), forwardReceiptSha256: hash(input.forwardReceipt),
    sources: Object.fromEntries(Object.entries(sourceMetadata).map(([service, source]) => [service,
      { ...structuredClone(source), filesSha256: hash(canonical(files[service])) }])) };
  const parentProofSha256 = hash(canonical(parentProof));
  const manifest = { version: 1, status: "P2_LIFECYCLE_OWNED_SOURCE_MANIFEST", mode: "postgres18-container", parentProofSha256,
    identityManifestSha256: input.identityManifestSha256, sources: manifestSources };
  const manifestBytes = Buffer.from(canonical(manifest));
  const verified = verifyP2LifecycleOwnedSourceManifest(manifestBytes, roots);
  const sourceCommits = Object.fromEntries(Object.entries(verified.manifest.sources).map(([service, source]) => [service, source.revision]));
  const sourceSha256 = Object.fromEntries(LIFECYCLE_SOURCE_FILES.map(name =>
    [name, verified.manifest.sources.frontend.files[`ops/platform/${name}`]]));
  const receiverSourceSha256 = Object.fromEntries(LIFECYCLE_RECEIVER_SOURCE_FILES.map(name =>
    [name, verified.manifest.sources.frontend.files[`ops/platform/${name}`]]));
  demand(Object.values(sourceSha256).every(value => digest(value)));
  demand(Object.values(receiverSourceSha256).every(value => digest(value)));
  return Object.freeze({ manifestBytes, sourceManifestSha256: verified.sourceManifestSha256, parentProofSha256,
    expectedReceipt: Object.freeze({ sourceCommits: Object.freeze(sourceCommits), sourceSha256: Object.freeze(sourceSha256),
      sourceManifestSha256: verified.sourceManifestSha256 }),
    expectedReceiverReceipt: Object.freeze({ sourceCommits: Object.freeze(sourceCommits), sourceSha256: Object.freeze(receiverSourceSha256),
      sourceManifestSha256: verified.sourceManifestSha256 }) });
}

export function parseP2LifecyclePersistencePostgres18Receipt(output, expected) {
  demand(typeof output === "string" && output.length > 0 && output.length <= 1_000_000 &&
    exactKeys(expected, ["sourceCommits", "sourceSha256", "sourceManifestSha256"]) && digest(expected.sourceManifestSha256));
  const lines = output.trim().split("\n");
  demand(lines.length === 1);
  const receipt = JSON.parse(lines[0]);
  demand(exactKeys(receipt, LIFECYCLE_RECEIPT_KEYS) && receipt.version === 1 &&
    receipt.status === "P2_LIFECYCLE_PERSISTENCE_OWNED_POSTGRES18_PASS" && receipt.postgresMajor === 18 &&
    receipt.frontendMigrations === 83 && receipt.courseMigrations === 22 && receipt.communityMigrations === 11 &&
    JSON.stringify(receipt.checks) === JSON.stringify(LIFECYCLE_CHECKS) && receipt.skipped === 0 && receipt.readOnly === true &&
    receipt.fixtureOnly === true && receipt.providerTouched === false && receipt.liveCertification === false &&
    receipt.sourceMode === "parent-issued-manifest-and-mounted-readback" &&
    receipt.sourceManifestSha256 === expected.sourceManifestSha256 &&
    canonical(receipt.sourceCommits) === canonical(expected.sourceCommits) && canonical(receipt.sourceSha256) === canonical(expected.sourceSha256));
  return receipt;
}

export function parseP2LifecycleReceiversPostgres18Receipt(output, expected) {
  demand(typeof output === "string" && output.length > 0 && output.length <= 1_000_000 &&
    exactKeys(expected, ["sourceCommits", "sourceSha256", "sourceManifestSha256"]) && digest(expected.sourceManifestSha256));
  const lines = output.trim().split("\n");
  demand(lines.length === 1);
  const receipt = JSON.parse(lines[0]);
  demand(exactKeys(receipt, LIFECYCLE_RECEIVER_RECEIPT_KEYS) && receipt.version === 1 &&
    receipt.status === "P2_LIFECYCLE_RECEIVER_OWNED_POSTGRES18_PASS" && receipt.postgresMajor === 18 &&
    receipt.frontendMigrations === 83 && receipt.courseMigrations === 22 && receipt.communityMigrations === 11 &&
    JSON.stringify(receipt.checks) === JSON.stringify(LIFECYCLE_RECEIVER_CHECKS) && receipt.httpCaseCount === 8 && receipt.skipped === 0 &&
    receipt.domainStatePreserving === true && receipt.globallyReadOnly === false && receipt.quotaWritesObserved === true &&
    receipt.deployedFutureGapQualified === false && receipt.hostDockerPathQualified === false && receipt.fixtureOnly === true &&
    receipt.providerTouched === false && receipt.liveCertification === false &&
    receipt.sourceMode === "parent-issued-manifest-and-mounted-readback" &&
    receipt.sourceManifestSha256 === expected.sourceManifestSha256 &&
    canonical(receipt.sourceCommits) === canonical(expected.sourceCommits) && canonical(receipt.sourceSha256) === canonical(expected.sourceSha256));
  return receipt;
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

export function parseP2ForwardRecoveryPostgres18Receipt(output) {
  demand(typeof output === "string" && output.length > 0 && output.length <= 1_000_000);
  const lines = output.trim().split("\n");
  demand(lines.length === 1);
  const receipt = JSON.parse(lines[0]);
  const isolation = receipt?.environmentIsolation;
  const isolationMatches = isolation && JSON.stringify(Object.keys(isolation).sort()) ===
    JSON.stringify(Object.keys(RECOVERY_ENVIRONMENT_ISOLATION).sort()) &&
    Object.entries(RECOVERY_ENVIRONMENT_ISOLATION).every(([name, expected]) => isolation[name] === expected);
  demand(receipt && JSON.stringify(Object.keys(receipt).sort()) === JSON.stringify(FORWARD_RECOVERY_RECEIPT_KEYS) &&
    receipt.status === "OWNED_P2_RECOVERY_FORWARD_CHECKS_PASS" && receipt.serverMajor === 18 &&
    receipt.frontendMigrations === 83 && receipt.courseMigrations === 22 && receipt.communityMigrations === 11 &&
    JSON.stringify(receipt.checks) === JSON.stringify(FORWARD_RECOVERY_CHECKS) && receipt.mutationRefusals === 1 &&
    receipt.runtimeCredentialRefusals === 9 && receipt.foreignRuntimeTlsAuthenticated === true && receipt.runtimeCredentialFaultProviderCalls === 0 &&
    receipt.noSqlReplay === true && receipt.journalDigestsUnchanged === true && receipt.originalFrontendTerminalRecreated === false &&
    receipt.skipped === 0 && receipt.fixtureOnly === true && receipt.providerTouched === false &&
    receipt.actualRuntimeContainers === false && isolationMatches);
  return receipt;
}

const INTERRUPTED_OUTER_KEYS = ("version status actualAppCron actualDispatcher actualTlsGateway actualTlsReceivers actualCanonicalApiReceivers " +
  "actualThreeDatabaseDomainProof actualTlsPostgres actualProvider modeledOidc firstHttpStatus firstFrontendLedgerState firstFrontendUncertain " +
  "firstGatewayUncertain firstDeliveries replayHttpStatus finalFrontendUncertain finalGatewayUncertain finalDeliveries sourceTraceMatchesOperation " +
  "settledFrontendUncertain specificFrontendOperationReconciled gatewayCounterReset domainProofSha256 canonicalFaultRefusals immutableReceiptRewriteRefusals " +
  "sourceDomainReducer sourceSettlementReducer backendEligibility journalSha256Before journalSha256After allThreeJournalsUnchanged noSqlReplay noRoleChange " +
  "noRuntimeRestart fixtureOnly restoration postgresMajor migrations frontendSourceCommit apiSourceCommits apiSourceArchives fixtureSourceSha256 " +
  "sqlArtifactSha256 actualVercelNativeEvidence providerTouched").split(" ");
const INTERRUPTED_RESTORATION_KEYS = ("status serverMajor migrations actualThreeDatabases actualTlsScram oldProcessExited oldBackendEnded newFrontendBackend " +
  "newHostProcess actualHostFlock newSourceCapability oldOneRetained newZeroVerifiedInProjectedRuntime allTenSourceStages allThreeJournalsUnchanged " +
  "sqlReplayed frontendReadinessVerified trafficAuthorized providerTouched actualDocker runtimeTransportProjected requestCount terminalReceiptSha256 " +
  "terminalReceipt elapsedSeconds ownedSourceSha256 gatewayDependency originalCausalReceiptSha256").split(" ");
const INTERRUPTED_CAUSAL_NAMES = Object.freeze(["recovery-intent.json", "baseline.json", "domain.json", "request-details.json", "settlement.json", "replacement-authorization.json"]);
const INTERRUPTED_TERMINAL_KEYS = ("status environment releaseId recoveryActionId candidateSha256 apiDatabases containers boundaryChecks sqlReplayed " +
  "rolePreparationRepeated trafficAuthorized contractPhase phase2ContractManifestSha256 restorationActionId originalCertificationActionId originalRecoveryActionId " +
  "oldGateway newGateway apiDatabasesAfter originalGatewayUncertaintyPreserved ordinaryClosedZeroGate runtimeReplacements nativeDisabled frontendReadinessVerified " +
  "frontendWorkloadProbePerformed originalTerminalRecreated frontendJournalSha256 originalCausalReceiptSha256").split(" ");
const KNOWN_ACK_BACKEND_FAULTS = Object.freeze(["missing-scheduler-receipts", "community-retention-schedule-horizon", "missing-course-control",
  "projection-completeness-bound", "future-course-outbox", "course-outbox-lease", "completed-course-effect-projection", "course-snapshot-work",
  "course-snapshot-expiry-horizon", "course-retention-horizon", "course-media-horizon", "course-export-expiry-horizon", "community-export-expiry-horizon",
  "future-community-repair", "completed-community-effect-projection", "community-reconciliation-work", "community-reconciliation-schedule-horizon",
  "unrelated-course-lifecycle-command", "unrelated-community-lifecycle-command", "unrelated-course-mutable-lifecycle-state", "unrelated-community-mutable-lifecycle-state"]);
const same = (first, second) => canonical(first) === canonical(second);
const valuesMatch = (value, expected) => Object.entries(expected).every(([key, selected]) => value[key] === selected);
const migrationCounts = value => exactKeys(value, ["frontend", "course", "community"]) && valuesMatch(value, { frontend: 83, course: 22, community: 11 });
const positiveInteger = value => Number.isSafeInteger(value) && value > 0 && value <= 1_000_000;
const domainHashes = value => exactKeys(value, ["frontend", "course", "community"]) && Object.values(value).every(item => digest(item));

function validateInterruptedGateway(value, expected, previous) {
  demand(exactKeys(value, ["status", "binding", "process", "admission"]) && value.status === "PRIOR_GATEWAY_OBSERVED");
  const binding = value.binding, process = value.process, admission = value.admission;
  demand(exactKeys(binding, ["releaseId", "candidateSha256", "hostMachineId", "gatewayImage", "runtimeConfigurationSha256", "gatewayConfigurationSha256", "configurationDirectory"]) &&
    binding.releaseId === expected.releaseId && binding.candidateSha256 === expected.candidateSha256 &&
    binding.hostMachineId === "1".repeat(32) && binding.gatewayImage === expected.gatewayImage &&
    digest(binding.runtimeConfigurationSha256) && digest(binding.gatewayConfigurationSha256) &&
    typeof binding.configurationDirectory === "string" && /^\/[A-Za-z0-9_./-]{1,1024}$/u.test(binding.configurationDirectory) &&
    !binding.configurationDirectory.split("/").includes(".."));
  demand(exactKeys(process, ["containerId", "imageId", "running", "pid", "startedAt", "restartCount"]) && digest(process.containerId) &&
    process.imageId === expected.gatewayImage.split("@")[1] && process.running === true && positiveInteger(process.pid) &&
    process.restartCount === 0 && typeof process.startedAt === "string" && process.startedAt.length <= 40 && Number.isFinite(Date.parse(process.startedAt)));
  demand(exactKeys(admission, ["newWork", "recovery", "active", "uncertain", "sha256"]) && admission.newWork === false && admission.recovery === false &&
    same(admission.active, { newWork: 0, recovery: 0 }) && same(admission.uncertain, { newWork: 0, recovery: previous ? 1 : 0 }) && digest(admission.sha256));
}

function validateInterruptedApi(value, service, expected, terminal, journals) {
  const keys = ("version status service environment releaseId sourceCommit migrationImageDigest runtimeImageDigest schemaBaselineSha256 contractSha256 " +
    "contractPhase phase2ContractManifestSha256 candidateSha256 recoveryActionId journalSha256 artifactSha256 pendingTags readOnlyVerified schemaVerified runtimeRoleVerified sqlReplayed").split(" ");
  demand(exactKeys(value, keys) && valuesMatch(value, { version: 1, status: "P2_RECOVERY_API_DATABASE_CURRENT", service: `lash-her-${service}-api`,
    environment: "staging", releaseId: terminal.releaseId, sourceCommit: expected.apiSourceCommits[service], contractPhase: "p2",
    phase2ContractManifestSha256: terminal.phase2ContractManifestSha256, candidateSha256: terminal.candidateSha256,
    recoveryActionId: terminal.restorationActionId, journalSha256: journals[service], readOnlyVerified: true, schemaVerified: true,
    runtimeRoleVerified: true, sqlReplayed: false }) && same(value.pendingTags, []) &&
    value.migrationImageDigest === expected.candidate.artifacts[service + "Migration"].image.split("@")[1] &&
    value.runtimeImageDigest === expected.candidate.artifacts[service + "Runtime"].image.split("@")[1] &&
    ["schemaBaselineSha256", "contractSha256", "artifactSha256"].every(key => digest(value[key])));
}

function validateInterruptedExpected(expected) {
  demand(exactKeys(expected, ["frontendSourceCommit", "apiSourceCommits", "apiSourceLocks", "ownedSourceSha256", "fixtureSourceSha256", "candidate", "gatewayDependency"]) &&
    digest(expected.frontendSourceCommit, 40) && same(expected.apiSourceCommits, P2_LIFECYCLE_OWNED_API_REVISIONS) &&
    exactKeys(expected.apiSourceLocks, ["course", "community"]) && Object.values(expected.apiSourceLocks).every(value => digest(value)) &&
    exactKeys(expected.ownedSourceSha256, P2_INTERRUPTED_OWNED_SOURCE_FILES) && Object.values(expected.ownedSourceSha256).every(value => digest(value)) &&
    exactKeys(expected.fixtureSourceSha256, P2_KNOWN_ACK_OWNED_SOURCE_FILES) && Object.values(expected.fixtureSourceSha256).every(value => digest(value)) &&
    exactKeys(expected.gatewayDependency, ["package", "version", "resolution", "packageSha256"]) &&
    valuesMatch(expected.gatewayDependency, { package: "jose", version: "6.2.3", resolution: "ops/gateway/node_modules/jose" }) &&
    digest(expected.gatewayDependency.packageSha256) && expected.candidate?.environment === "staging" && expected.candidate.contractPhase === "p2" &&
    expected.candidate.sources?.frontend?.commit === expected.frontendSourceCommit);
}

export function parseP2InterruptedRestorationPostgres18Receipt(output, expected) {
  demand(typeof output === "string" && output.length > 0 && Buffer.byteLength(output) <= 1_000_000);
  validateInterruptedExpected(expected);
  const receipt = JSON.parse(output), restoration = receipt?.restoration, terminal = restoration?.terminalReceipt;
  demand(exactKeys(receipt, INTERRUPTED_OUTER_KEYS) && exactKeys(restoration, INTERRUPTED_RESTORATION_KEYS) && exactKeys(terminal, INTERRUPTED_TERMINAL_KEYS));
  demand(valuesMatch(receipt, { version: 1, status: "P2_KNOWN_ACK_WHOLE_ROUTE_PASS", postgresMajor: 18, fixtureOnly: true,
    actualAppCron: true, actualDispatcher: true, actualTlsGateway: true, actualTlsReceivers: true, actualCanonicalApiReceivers: true,
    actualThreeDatabaseDomainProof: true, actualTlsPostgres: true, actualProvider: false, modeledOidc: true,
    firstHttpStatus: 503, firstFrontendLedgerState: "uncertain", firstFrontendUncertain: 1, firstGatewayUncertain: 1,
    replayHttpStatus: 200, finalFrontendUncertain: 1, finalGatewayUncertain: 1, sourceTraceMatchesOperation: true,
    settledFrontendUncertain: 0, specificFrontendOperationReconciled: true, gatewayCounterReset: false,
    canonicalFaultRefusals: 2, immutableReceiptRewriteRefusals: 2, allThreeJournalsUnchanged: true, noSqlReplay: true,
    noRoleChange: true, noRuntimeRestart: true, actualVercelNativeEvidence: false, providerTouched: false,
    frontendSourceCommit: expected.frontendSourceCommit }) && migrationCounts(receipt.migrations) && digest(receipt.domainProofSha256) && digest(receipt.sqlArtifactSha256));
  const deliveries = (value, replay) => same(value, [
    { receiver: "community", status: "acknowledged", attempts: 1, lease_id: null, lease_until: null },
    { receiver: "course", status: replay ? "acknowledged" : "pending", attempts: replay ? 2 : 1, lease_id: null, lease_until: null },
  ]);
  demand(deliveries(receipt.firstDeliveries, false) && deliveries(receipt.finalDeliveries, true) &&
    domainHashes(receipt.journalSha256Before) && same(receipt.journalSha256Before, receipt.journalSha256After) &&
    same(receipt.apiSourceCommits, expected.apiSourceCommits) && exactKeys(receipt.apiSourceArchives, ["course", "community"]) &&
    same(receipt.fixtureSourceSha256, expected.fixtureSourceSha256));
  for (const service of ["course", "community"]) demand(exactKeys(receipt.apiSourceArchives[service], ["sha256", "lockSha256"]) &&
    digest(receipt.apiSourceArchives[service].sha256) && receipt.apiSourceArchives[service].lockSha256 === expected.apiSourceLocks[service]);
  demand(exactKeys(receipt.sourceDomainReducer, ["status", "faultRefusals", "backendFaultRefusals", "plainReceiptAuthorityRefused", "authorityIssued"]) &&
    valuesMatch(receipt.sourceDomainReducer, { status: "P2_KNOWN_ACK_SOURCE_DOMAIN_REDUCER_PASS", faultRefusals: 11, backendFaultRefusals: 21,
      plainReceiptAuthorityRefused: true, authorityIssued: false }) &&
    exactKeys(receipt.sourceSettlementReducer, ["status", "extraCompletedOperationRefused", "authorityIssued"]) &&
    valuesMatch(receipt.sourceSettlementReducer, { status: "P2_KNOWN_ACK_SPECIFIC_SETTLEMENT_REDUCER_PASS", extraCompletedOperationRefused: true, authorityIssued: false }) &&
    exactKeys(receipt.backendEligibility, ["actualReadOnlyProjections", "sourceSchedulerBaseline", "sourceRetentionBaseline", "faultRefusals", "faultNames", "entireParentHorizonSeconds", "liveWorkerProcesses"]) &&
    valuesMatch(receipt.backendEligibility, { actualReadOnlyProjections: true, sourceSchedulerBaseline: true, sourceRetentionBaseline: true,
      faultRefusals: 21, entireParentHorizonSeconds: 900, liveWorkerProcesses: false }) && same(receipt.backendEligibility.faultNames, KNOWN_ACK_BACKEND_FAULTS));
  demand(valuesMatch(restoration, { status: "P2_INTERRUPTED_NEW_PROCESS_OWNED_PASS", serverMajor: 18, actualThreeDatabases: true,
    actualTlsScram: true, oldProcessExited: true, oldBackendEnded: true, newFrontendBackend: true, newHostProcess: true,
    actualHostFlock: true, newSourceCapability: true, oldOneRetained: true, newZeroVerifiedInProjectedRuntime: true,
    allTenSourceStages: true, allThreeJournalsUnchanged: true, sqlReplayed: false, frontendReadinessVerified: false,
    trafficAuthorized: false, providerTouched: false, actualDocker: false, runtimeTransportProjected: true }) && migrationCounts(restoration.migrations) &&
    positiveInteger(restoration.requestCount) && Number.isFinite(restoration.elapsedSeconds) && restoration.elapsedSeconds > 0 && restoration.elapsedSeconds <= 1200 &&
    same(restoration.ownedSourceSha256, expected.ownedSourceSha256) && same(restoration.gatewayDependency, expected.gatewayDependency) &&
    restoration.terminalReceiptSha256 === hash(JSON.stringify(terminal) + "\n"));
  const candidateSha256 = hash(JSON.stringify(expected.candidate) + "\n");
  demand(valuesMatch(terminal, { status: "P2_KNOWN_ACK_INTERRUPTED_RUNTIME_RESTORED_FENCED", environment: "staging",
    releaseId: expected.candidate.releaseId, candidateSha256, recoveryActionId: "owned-interrupted-restoration-c",
    restorationActionId: "owned-interrupted-restoration-c", originalCertificationActionId: "owned-b-certification", originalRecoveryActionId: "owned-b-replacement",
    sqlReplayed: false, rolePreparationRepeated: false, trafficAuthorized: false, contractPhase: "p2",
    phase2ContractManifestSha256: expected.candidate.phase2ContractManifestSha256, originalGatewayUncertaintyPreserved: true,
    ordinaryClosedZeroGate: false, runtimeReplacements: 1, nativeDisabled: true, frontendReadinessVerified: false,
    frontendWorkloadProbePerformed: false, originalTerminalRecreated: false, frontendJournalSha256: receipt.journalSha256Before.frontend }) &&
    same(terminal.boundaryChecks, INTERRUPTED_BOUNDARIES) && exactKeys(terminal.apiDatabases, ["course", "community"]) &&
    same(terminal.apiDatabases, terminal.apiDatabasesAfter));
  for (const service of ["course", "community"]) validateInterruptedApi(terminal.apiDatabases[service], service, expected, terminal, receipt.journalSha256Before);
  demand(Array.isArray(terminal.containers) && same(terminal.containers.map(value => value.service), INTERRUPTED_SERVICES) &&
    new Set(terminal.containers.map(value => value.containerId)).size === 10);
  for (const row of terminal.containers) {
    const artifact = row.service === "gateway" || row.service.endsWith("-tls") ? "gateway" : row.service.startsWith("community-") ? "communityRuntime" : "courseRuntime";
    demand(exactKeys(row, ["service", "containerId", "image", "health"]) && digest(row.containerId) &&
      row.image === expected.candidate.artifacts[artifact].image && row.health === (row.service.endsWith("-tls") ? "none" : "healthy"));
  }
  const gatewayExpected = { releaseId: terminal.releaseId, candidateSha256, gatewayImage: expected.candidate.artifacts.gateway.image };
  validateInterruptedGateway(terminal.oldGateway, gatewayExpected, true); validateInterruptedGateway(terminal.newGateway, gatewayExpected, false);
  demand(terminal.oldGateway.process.containerId !== terminal.newGateway.process.containerId &&
    terminal.oldGateway.binding.configurationDirectory !== terminal.newGateway.binding.configurationDirectory &&
    same(Object.fromEntries(Object.entries(terminal.oldGateway.binding).filter(([name]) => name !== "configurationDirectory")),
      Object.fromEntries(Object.entries(terminal.newGateway.binding).filter(([name]) => name !== "configurationDirectory"))) &&
    terminal.containers.at(-1).containerId === terminal.newGateway.process.containerId &&
    exactKeys(restoration.originalCausalReceiptSha256, INTERRUPTED_CAUSAL_NAMES) &&
    Object.values(restoration.originalCausalReceiptSha256).every(value => digest(value)) &&
    same(terminal.originalCausalReceiptSha256, restoration.originalCausalReceiptSha256));
  return receipt;
}

const INTERRUPTED_NEGATIVE_CASES = Object.freeze(["original-bytes", "original-config-drift", "missing-lineage", "pending-lineage", "backend-effect", "active-backend-loss", "active-guard-loss"]);
const INTERRUPTED_NEGATIVE_KEYS = ("status case actualThreeDatabases actualTlsScram newHostProcess newFrontendBackend actualHostFlock Bterminal Cterminal " +
  "actualGuardWriterExited authorityIssued cleanedNamespaces nativeDisabled oldOneRetained runtimeStopped upCommands allThreeJournalsUnchanged providerTouched " +
  "actualDocker runtimeTransportProjected frontendReadinessVerified trafficAuthorized elapsedSeconds ownedSourceSha256 gatewayDependency").split(" ");

export function parseP2InterruptedNegativesPostgres18Receipt(output, expected) {
  demand(typeof output === "string" && output.length > 0 && Buffer.byteLength(output) <= 1_000_000);
  validateInterruptedExpected(expected);
  const receipt = JSON.parse(output);
  demand(exactKeys(receipt, ["version", "status", "serverMajor", "cases", "elapsedSeconds"]) &&
    valuesMatch(receipt, { version: 1, status: "P2_INTERRUPTED_NEGATIVES_OWNED_PASS", serverMajor: 18 }) &&
    Array.isArray(receipt.cases) && same(receipt.cases.map(value => value?.case), INTERRUPTED_NEGATIVE_CASES) &&
    Number.isFinite(receipt.elapsedSeconds) && receipt.elapsedSeconds > 0 && receipt.elapsedSeconds <= 1200);
  let previous = 0;
  for (const row of receipt.cases) {
    const active = ["active-backend-loss", "active-guard-loss"].includes(row.case), current = active || row.case === "backend-effect";
    demand(exactKeys(row, INTERRUPTED_NEGATIVE_KEYS) && valuesMatch(row, {
      status: "P2_INTERRUPTED_NEGATIVE_OWNED_PASS", actualThreeDatabases: true, actualTlsScram: true,
      newHostProcess: true, newFrontendBackend: current, actualHostFlock: true, Bterminal: false, Cterminal: false,
      actualGuardWriterExited: row.case === "active-guard-loss", authorityIssued: active, nativeDisabled: current ? true : null,
      oldOneRetained: true, runtimeStopped: current ? true : null, upCommands: active ? 1 : 0,
      allThreeJournalsUnchanged: true, providerTouched: false, actualDocker: false, runtimeTransportProjected: true,
      frontendReadinessVerified: false, trafficAuthorized: false }) &&
      same(row.cleanedNamespaces, current ? ["certification", "recovery"] : []) &&
      same(row.ownedSourceSha256, expected.ownedSourceSha256) && same(row.gatewayDependency, expected.gatewayDependency) &&
      Number.isFinite(row.elapsedSeconds) && row.elapsedSeconds > previous && row.elapsedSeconds <= receipt.elapsedSeconds);
    previous = row.elapsedSeconds;
  }
  return receipt;
}

function runRecoveryQualification(run, dockerEndpoint, args, frontendRoot, environment, diagnostic, qualification, sourceCommit, input) {
  demand(RECOVERY_QUALIFICATIONS.includes(qualification) && digest(sourceCommit, 40));
  diagnostic.recoveryQualification = qualification;
  diagnostic.recoveryFailure = "docker-transport";
  diagnostic.recoveryStarted = true;
  const result = run("docker", ["--host", dockerEndpoint, ...args],
    { cwd: frontendRoot, env: environment, timeout: 600_000, maxBuffer: 4 * 1024 * 1024, input });
  if (!(result && !result.error && result.status === 0 && result.signal == null &&
    typeof result.stdout === "string" && typeof result.stderr === "string")) {
    diagnostic.recoveryFailure = result?.status === 125 || result?.error ? "docker-transport" : "child-exit";
    retainPrivateDockerFailure(qualification, sourceCommit, diagnostic.recoveryFailure, result);
    demand(false);
  }
  diagnostic.recoveryFailure = "receipt-invalid";
  return result;
}

function parseRecoveryQualification(parser, result, qualification, sourceCommit) {
  try { return parser(result.stdout); }
  catch (error) {
    retainPrivateDockerFailure(qualification, sourceCommit, "receipt-invalid", result);
    throw error;
  }
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

function frontendPackageProof(directory) {
  return { packageSha256: hash(readBounded(join(directory, "package.json"), 256_000)),
    packageLockSha256: hash(readBounded(join(directory, "package-lock.json"), 2_000_000)) };
}

function verifyLifecycleQualificationSources(run, frontendRoot, directories, frontendSource, sources, manifest,
  environment, sourceReadToken, expectedFiles) {
  demand(verifyP2FrontendSourceProof(run, frontendRoot, frontendSource.revision, environment).gitTree === frontendSource.gitTree &&
    canonical(frontendPackageProof(frontendRoot)) === canonical({ packageSha256: frontendSource.packageSha256,
      packageLockSha256: frontendSource.packageLockSha256 }));
  for (const [service, definition] of Object.entries(REPOSITORIES)) {
    verifyApiSourceForMount(run, directories[service], sources[service].revision, definition, environment, sourceReadToken);
    demand(canonical(validatePackage(directories[service], definition)) === canonical({ packageSha256: sources[service].packageSha256,
      packageLockSha256: sources[service].packageLockSha256 }) &&
      canonical(verifyArtifacts(directories[service], manifest, definition.name)) === canonical(sources[service].artifactSha256));
  }
  const files = { frontend: p2LifecycleOwnedSourceFileMap("frontend", frontendRoot),
    course: p2LifecycleOwnedSourceFileMap("course", directories.course),
    community: p2LifecycleOwnedSourceFileMap("community", directories.community) };
  if (expectedFiles !== undefined) demand(canonical(files) === canonical(expectedFiles));
  return files;
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
  const dockerSocketStat = options.dockerSocketStat ?? lstatSync;
  const sourceReadToken = process.env.PLATFORM_SOURCE_READ_TOKEN;
  demand(typeof run === "function" && typeof makeTemporaryDirectory === "function" &&
    typeof dockerSocketStat === "function" && (options.dockerSocketStat === undefined || options.run !== undefined) &&
    [undefined, true, false].includes(options.recoveryPostgres18) && [undefined, true, false].includes(options.lifecyclePostgres18) &&
    (options.lifecyclePostgres18 !== true || options.recoveryPostgres18 === true));
  demand(Number((options.nodeVersion ?? process.versions.node).split(".")[0]) === 24);
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
    const frontendTree = verifyP2FrontendSourceProof(run, frontendRoot, frontendCommit, installEnvironment).gitTree;
    const frontendSource = { repository: FRONTEND_REPOSITORY.name, revision: frontendCommit, gitTree: frontendTree,
      ...frontendPackageProof(frontendRoot), artifactSha256: {} };
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
    let recovery, forwardRecovery, lifecyclePersistence, lifecycleReceivers, interruptedRestoration, interruptedRestorationNegatives;
    if (options.recoveryPostgres18 === true) {
      mark(diagnostic, "recovery-postgres18", "recovery");
      for (const [service, definition] of Object.entries(REPOSITORIES))
        verifyApiSourceForMount(run, directories[service], manifest.artifacts[service].revision, definition, installEnvironment, sourceReadToken);
      for (const directory of Object.values(directories)) makeApiSourceMountable(directory);
      const recoveryArguments = recoveryDockerArguments(frontendRoot, directories);
      const forwardArguments = forwardRecoveryDockerArguments(frontendRoot, directories);
      diagnostic.recoveryQualification = "current";
      diagnostic.recoveryFailure = "docker-transport";
      const dockerEndpoint = currentDockerContextEndpoint(run, dockerSocketStat, frontendRoot);
      const recoveryEnvironment = dockerEnvironment(workspace);
      mark(diagnostic, "exact-source-proof", "frontend");
      const qualificationFiles = verifyLifecycleQualificationSources(run, frontendRoot, directories, frontendSource, sources,
        manifest, installEnvironment, sourceReadToken);
      mark(diagnostic, "recovery-postgres18", "recovery");
      const currentResult = runRecoveryQualification(run, dockerEndpoint, recoveryArguments,
        frontendRoot, recoveryEnvironment, diagnostic, "current", frontendCommit);
      const currentOutput = currentResult.stdout;
      const receipt = parseRecoveryQualification(parseP2RecoveryPostgres18Receipt, currentResult, "current", frontendCommit);
      recovery = { status: receipt.status, serverMajor: receipt.serverMajor, frontendMigrations: receipt.frontendMigrations,
        courseMigrations: receipt.courseMigrations, communityMigrations: receipt.communityMigrations, skipped: receipt.skipped,
        fixtureOnly: receipt.fixtureOnly, providerTouched: receipt.providerTouched, checks: receipt.checks,
        privilegeFaults: receipt.privilegeFaults, frontendInitialPrivilegeRefusals: receipt.frontendInitialPrivilegeRefusals,
        frontendContinuousPrivilegeRefusals: receipt.frontendContinuousPrivilegeRefusals, apiPrivilegeRefusals: receipt.apiPrivilegeRefusals,
        legacyApiVerifierRefusals: receipt.legacyApiVerifierRefusals, frontendCreatorPolicy: receipt.frontendCreatorPolicy,
        frontendCreatorMemberships: receipt.frontendCreatorMemberships,
        frontendOperatorSearchPathPinned: receipt.frontendOperatorSearchPathPinned, environmentIsolation: receipt.environmentIsolation,
        noSqlReplay: receipt.noSqlReplay, originalFrontendTerminalRecreated: receipt.originalFrontendTerminalRecreated };
      mark(diagnostic, "exact-source-proof", "frontend");
      verifyLifecycleQualificationSources(run, frontendRoot, directories, frontendSource, sources,
        manifest, installEnvironment, sourceReadToken, qualificationFiles);
      mark(diagnostic, "recovery-postgres18", "recovery");
      const forwardResult = runRecoveryQualification(run, dockerEndpoint, forwardArguments,
        frontendRoot, recoveryEnvironment, diagnostic, "forward", frontendCommit);
      const forwardOutput = forwardResult.stdout;
      const forwardReceipt = parseRecoveryQualification(parseP2ForwardRecoveryPostgres18Receipt, forwardResult, "forward", frontendCommit);
      const apiSourcePins = Object.fromEntries(["course", "community"].map(service => [service, {
        revision: sources[service].revision, gitTree: sources[service].gitTree, packageSha256: sources[service].packageSha256,
        packageLockSha256: sources[service].packageLockSha256, artifactSha256: structuredClone(sources[service].artifactSha256),
      }]));
      forwardRecovery = { status: forwardReceipt.status, serverMajor: forwardReceipt.serverMajor,
        frontendMigrations: forwardReceipt.frontendMigrations, courseMigrations: forwardReceipt.courseMigrations,
        communityMigrations: forwardReceipt.communityMigrations, checks: forwardReceipt.checks,
        mutationRefusals: forwardReceipt.mutationRefusals, noSqlReplay: forwardReceipt.noSqlReplay,
        runtimeCredentialRefusals: forwardReceipt.runtimeCredentialRefusals, foreignRuntimeTlsAuthenticated: forwardReceipt.foreignRuntimeTlsAuthenticated,
        runtimeCredentialFaultProviderCalls: forwardReceipt.runtimeCredentialFaultProviderCalls,
        journalDigestsUnchanged: forwardReceipt.journalDigestsUnchanged,
        originalFrontendTerminalRecreated: forwardReceipt.originalFrontendTerminalRecreated, skipped: forwardReceipt.skipped,
        fixtureOnly: forwardReceipt.fixtureOnly, providerTouched: forwardReceipt.providerTouched,
        actualRuntimeContainers: forwardReceipt.actualRuntimeContainers, environmentIsolation: forwardReceipt.environmentIsolation,
        apiSourcePins };
      mark(diagnostic, "exact-source-proof", "frontend");
      verifyLifecycleQualificationSources(run, frontendRoot, directories, frontendSource, sources,
        manifest, installEnvironment, sourceReadToken, qualificationFiles);
      if (options.lifecyclePostgres18 === true) {
        const lifecycleInput = buildP2LifecyclePersistencePostgres18Input({ frontendRoot, directories, frontendSource, sources,
          identityManifestSha256: hash(manifestBytes), currentReceipt: currentOutput, forwardReceipt: forwardOutput });
        mark(diagnostic, "lifecycle-postgres18", "lifecycle");
        const lifecycleResult = runRecoveryQualification(run, dockerEndpoint, lifecyclePersistenceDockerArguments(frontendRoot, directories),
          frontendRoot, recoveryEnvironment, diagnostic, "persistence", frontendCommit, lifecycleInput.manifestBytes);
        const lifecycleReceipt = parseRecoveryQualification(output =>
          parseP2LifecyclePersistencePostgres18Receipt(output, lifecycleInput.expectedReceipt), lifecycleResult, "persistence", frontendCommit);
        mark(diagnostic, "exact-source-proof", "frontend");
        verifyLifecycleQualificationSources(run, frontendRoot, directories, frontendSource, sources,
          manifest, installEnvironment, sourceReadToken, qualificationFiles);
        lifecyclePersistence = { status: lifecycleReceipt.status, postgresMajor: lifecycleReceipt.postgresMajor,
          frontendMigrations: lifecycleReceipt.frontendMigrations, courseMigrations: lifecycleReceipt.courseMigrations,
          communityMigrations: lifecycleReceipt.communityMigrations, checks: lifecycleReceipt.checks, skipped: lifecycleReceipt.skipped,
          fixtureOnly: lifecycleReceipt.fixtureOnly, providerTouched: lifecycleReceipt.providerTouched,
          sourceMode: lifecycleReceipt.sourceMode, sourceManifestSha256: lifecycleReceipt.sourceManifestSha256,
          parentProofSha256: lifecycleInput.parentProofSha256, sourceCommits: lifecycleReceipt.sourceCommits,
          sourceSha256: lifecycleReceipt.sourceSha256 };
        mark(diagnostic, "exact-source-proof", "frontend");
        verifyLifecycleQualificationSources(run, frontendRoot, directories, frontendSource, sources,
          manifest, installEnvironment, sourceReadToken, qualificationFiles);
        mark(diagnostic, "lifecycle-postgres18", "receivers");
        const receiverResult = runRecoveryQualification(run, dockerEndpoint, lifecycleReceiversDockerArguments(frontendRoot, directories),
          frontendRoot, recoveryEnvironment, diagnostic, "receivers", frontendCommit, lifecycleInput.manifestBytes);
        const receiverReceipt = parseRecoveryQualification(output =>
          parseP2LifecycleReceiversPostgres18Receipt(output, lifecycleInput.expectedReceiverReceipt), receiverResult, "receivers", frontendCommit);
        mark(diagnostic, "exact-source-proof", "frontend");
        verifyLifecycleQualificationSources(run, frontendRoot, directories, frontendSource, sources,
          manifest, installEnvironment, sourceReadToken, qualificationFiles);
        lifecycleReceivers = { status: receiverReceipt.status, postgresMajor: receiverReceipt.postgresMajor,
          frontendMigrations: receiverReceipt.frontendMigrations, courseMigrations: receiverReceipt.courseMigrations,
          communityMigrations: receiverReceipt.communityMigrations, checks: receiverReceipt.checks,
          httpCaseCount: receiverReceipt.httpCaseCount, skipped: receiverReceipt.skipped,
          domainStatePreserving: receiverReceipt.domainStatePreserving, globallyReadOnly: receiverReceipt.globallyReadOnly,
          quotaWritesObserved: receiverReceipt.quotaWritesObserved, deployedFutureGapQualified: receiverReceipt.deployedFutureGapQualified,
          hostDockerPathQualified: receiverReceipt.hostDockerPathQualified, fixtureOnly: receiverReceipt.fixtureOnly,
          providerTouched: receiverReceipt.providerTouched, sourceMode: receiverReceipt.sourceMode,
          sourceManifestSha256: receiverReceipt.sourceManifestSha256, parentProofSha256: lifecycleInput.parentProofSha256,
          sourceCommits: receiverReceipt.sourceCommits, sourceSha256: receiverReceipt.sourceSha256 };
        mark(diagnostic, "exact-source-proof", "frontend");
        verifyLifecycleQualificationSources(run, frontendRoot, directories, frontendSource, sources,
          manifest, installEnvironment, sourceReadToken, qualificationFiles);
        const expectedInterrupted = buildP2InterruptedRestorationExpected(frontendRoot, frontendSource, sources);
        mark(diagnostic, "lifecycle-postgres18", "interrupted-restoration");
        const interruptedResult = runRecoveryQualification(run, dockerEndpoint, interruptedRestorationDockerArguments(frontendRoot, directories),
          frontendRoot, recoveryEnvironment, diagnostic, "interrupted-restoration", frontendCommit);
        const interruptedReceipt = parseRecoveryQualification(output =>
          parseP2InterruptedRestorationPostgres18Receipt(output, expectedInterrupted), interruptedResult, "interrupted-restoration", frontendCommit);
        mark(diagnostic, "exact-source-proof", "frontend");
        verifyLifecycleQualificationSources(run, frontendRoot, directories, frontendSource, sources,
          manifest, installEnvironment, sourceReadToken, qualificationFiles);
        demand(same(buildP2InterruptedRestorationExpected(frontendRoot, frontendSource, sources), expectedInterrupted));
        const restored = interruptedReceipt.restoration;
        interruptedRestoration = { status: restored.status, serverMajor: restored.serverMajor, migrations: restored.migrations,
          sourceMode: "exact-source-owned-interrupted-restoration", frontendSourceCommit: interruptedReceipt.frontendSourceCommit,
          frontendSourceProof: frontendSource, apiSourcePins, ownedSourceSha256: restored.ownedSourceSha256, fixtureSourceSha256: interruptedReceipt.fixtureSourceSha256,
          gatewayDependency: restored.gatewayDependency, receiptSha256: hash(interruptedResult.stdout), terminalReceiptSha256: restored.terminalReceiptSha256,
          originalCausalReceiptSha256: restored.originalCausalReceiptSha256,
          knownAckPrefix: Object.fromEntries(["status", "noSqlReplay", "noRoleChange", "noRuntimeRestart", "firstHttpStatus", "replayHttpStatus",
            "specificFrontendOperationReconciled", "gatewayCounterReset"].map(key => [key, interruptedReceipt[key]])),
          actualThreeDatabases: true, actualTlsScram: true, oldProcessExited: true, oldBackendEnded: true, newFrontendBackend: true,
          newHostProcess: true, actualHostFlock: true, newSourceCapability: true, oldGatewayUncertainty: { newWork: 0, recovery: 1 },
          frontendUncertaintyAfterSettlement: 0, newGatewayUncertainty: { newWork: 0, recovery: 0 }, runtimeServices: 10,
          allThreeJournalsUnchanged: true, apiCurrentBeforeAfterVerified: true, sqlReplayed: false, frontendReadinessVerified: false,
          trafficAuthorized: false, fixtureOnly: true, providerTouched: false, actualProviderNativeEvidence: false, actualHostDocker: false,
          actualRootOperatorInstall: false, nodeCommittedSourceCallbackVerified: false, runtimeTransportProjected: true,
          nativeMetadataProjected: true, modeledOidc: true, skipped: 0 };
        mark(diagnostic, "exact-source-proof", "frontend");
        verifyLifecycleQualificationSources(run, frontendRoot, directories, frontendSource, sources,
          manifest, installEnvironment, sourceReadToken, qualificationFiles);
        demand(same(buildP2InterruptedRestorationExpected(frontendRoot, frontendSource, sources), expectedInterrupted));
        mark(diagnostic, "lifecycle-postgres18", "interrupted-negatives");
        const negativeResult = runRecoveryQualification(run, dockerEndpoint, interruptedNegativesDockerArguments(frontendRoot, directories),
          frontendRoot, recoveryEnvironment, diagnostic, "interrupted-negatives", frontendCommit);
        const negativeReceipt = parseRecoveryQualification(output =>
          parseP2InterruptedNegativesPostgres18Receipt(output, expectedInterrupted), negativeResult, "interrupted-negatives", frontendCommit);
        mark(diagnostic, "exact-source-proof", "frontend");
        verifyLifecycleQualificationSources(run, frontendRoot, directories, frontendSource, sources,
          manifest, installEnvironment, sourceReadToken, qualificationFiles);
        demand(same(buildP2InterruptedRestorationExpected(frontendRoot, frontendSource, sources), expectedInterrupted));
        interruptedRestorationNegatives = { status: negativeReceipt.status, serverMajor: negativeReceipt.serverMajor,
          cases: negativeReceipt.cases.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !["ownedSourceSha256", "gatewayDependency"].includes(key)))),
          frontendSourceCommit: frontendCommit, frontendSourceProof: frontendSource, apiSourcePins, fixtureSourceSha256: expectedInterrupted.fixtureSourceSha256,
          parentSourceProvenance: "parent-before-and-after-verified-readonly-mounts", childOwnedSourceReadback: true,
          ownedSourceSha256: expectedInterrupted.ownedSourceSha256, gatewayDependency: expectedInterrupted.gatewayDependency,
          receiptSha256: hash(negativeResult.stdout), fixtureOnly: true, skipped: 0, providerTouched: false,
          actualProviderNativeEvidence: false, actualHostDocker: false, actualRootOperatorInstall: false,
          nodeCommittedSourceCallbackVerified: false, runtimeTransportProjected: true, nativeMetadataProjected: true };
      }
    }
    mark(diagnostic, "exact-source-proof", "frontend");
    demand(verifyP2FrontendSourceProof(run, frontendRoot, frontendCommit, installEnvironment).gitTree === frontendTree);
    return { version: 1, status: lifecyclePersistence ? "P2_IDENTITY_RECOVERY_AND_LIFECYCLE_FIXTURES_PASS" :
      recovery ? "P2_IDENTITY_AND_RECOVERY_FIXTURES_PASS" : "P2_IDENTITY_PROBE_FIXTURES_PASS", frontendSourceCommit: frontendCommit,
      manifestSha256: hash(manifestBytes), nodeMajor: 24, npmMajor: 11, sources, tests,
      ...(recovery ? { recovery, forwardRecovery } : {}), ...(lifecyclePersistence ? { lifecyclePersistence, lifecycleReceivers, interruptedRestoration, interruptedRestorationNegatives } : {}),
      skipped: tests.skipped + (recovery?.skipped ?? 0) + (forwardRecovery?.skipped ?? 0) +
        (lifecyclePersistence?.skipped ?? 0) + (lifecycleReceivers?.skipped ?? 0) + (interruptedRestoration?.skipped ?? 0) +
        (interruptedRestorationNegatives?.skipped ?? 0), fixtureOnly: true, privateSourceFetch: true,
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
      recoveryStarted: { value: diagnostic.recoveryStarted === true },
      recoveryQualification: { value: RECOVERY_QUALIFICATIONS.includes(diagnostic.recoveryQualification) ? diagnostic.recoveryQualification : undefined },
      recoveryFailure: { value: RECOVERY_FAILURES.includes(diagnostic.recoveryFailure) ? diagnostic.recoveryFailure : undefined } });
    throw error;
  }
}

export function p2IdentityFixtureFailureReceipt(error) {
  const phase = FAILURE_PHASES.includes(error?.phase) ? error.phase : "preflight";
  const stage = FAILURE_STAGES.includes(error?.stage) ? error.stage : "frontend";
  const recoveryStarted = error?.recoveryStarted === true;
  return { version: 1, status: "P2_IDENTITY_PROBE_FIXTURES_REFUSED", phase, stage, fixtureOnly: true, providerTouched: false,
    stagingTouched: false, databaseConnected: recoveryStarted ? null : false, sqlExecuted: recoveryStarted ? null : false,
    ownedDisposableDatabaseExecutionAttempted: recoveryStarted,
    ...(RECOVERY_QUALIFICATIONS.includes(error?.recoveryQualification) ? { recoveryQualification: error.recoveryQualification } : {}),
    ...(RECOVERY_FAILURES.includes(error?.recoveryFailure) ? { recoveryFailure: error.recoveryFailure } : {}), releaseAccepted: false };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    demand(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === RECOVERY_MODE) ||
      (process.argv.length === 4 && process.argv[2] === RECOVERY_MODE && process.argv[3] === LIFECYCLE_MODE));
    process.stdout.write(JSON.stringify(prepareP2IdentityProbeFixtures({ recoveryPostgres18: process.argv[2] === RECOVERY_MODE,
      lifecyclePostgres18: process.argv[3] === LIFECYCLE_MODE })) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify(p2IdentityFixtureFailureReceipt(error)) + "\n");
    process.exitCode = 1;
  }
}
