import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_PATH = /^[A-Za-z0-9_./-]{1,240}$/u;
const API_REVISIONS = Object.freeze({
  course: "0bb054d5a04db71c481a8b3d182db6df19782cdc",
  community: "8594d953a5c0e0849e7a2e5e0de21f03537c4dc4",
});
const REHEARSAL_API_REVISIONS = Object.freeze({
  course: "54fd289a5a8579bfbe343afb07482f406b56ad5b",
  community: "929fdeb13e0e5f5e25454a457961d6ed965dedff",
});
const REPOSITORIES = Object.freeze({
  frontend: "lash-her-frontend",
  course: "lash-her-course-api",
  community: "lash-her-community-api",
});
const P2_CONTRACT_MANIFEST = "contracts/api-integration/p2-candidate/manifest.json";
const API_ARTIFACTS = Object.freeze({
  course: { service: "course", sourcePath: "openapi/course-api.json" },
  community: { service: "community", sourcePath: "openapi/community-api.json" },
  enrollmentEvent: { service: "community", sourcePath: "contracts/course-enrollment/v1/enrollment-event.schema.json" },
});
export const P2_INTERRUPTED_OWNED_SOURCE_FILES = Object.freeze([
  "ops/platform/p2-known-ack-interrupted-restoration.mjs", "ops/platform/host/p2_known_ack_interrupted_restoration.py",
  "ops/platform/host/p2_release_broker.py", "ops/platform/host/p2_release_supervisor.py",
  "ops/gateway/server.mjs", "ops/gateway/p2-certification-fault.mjs", "ops/gateway/package.json", "ops/gateway/package-lock.json",
  ...["run-owned.mjs", "owned-process.mjs", "owned-engine.py"].map(name =>
    `docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/${name}`),
]);
export const P2_KNOWN_ACK_OWNED_SOURCE_FILES = Object.freeze([
  "p2-known-ack-loss-probe.mjs", "host/p2_known_ack_loss.py", "harness/owned-p2-known-ack-loss.mjs",
  "harness/owned-phase2-lifecycle-receiver.mjs",
]);
const FRONTEND_DIRECTORIES = Object.freeze(["drizzle", "contracts/api-integration/p2-candidate"]);
const FRONTEND_FILES = Object.freeze([
  "package.json", "package-lock.json", "contracts/api-integration/v1/manifest.json",
  "src/lib/private-db/migration-lineage.ts", "scripts/api-contract-compatibility-review.mjs", "scripts/api-contract-tools.mjs",
  "ops/platform/frontend-migration.mjs", "ops/platform/frontend-schema.mjs", "ops/platform/source-checkout.mjs",
  "ops/platform/release.mjs", "ops/platform/release-inputs.mjs", "ops/platform/source-policy.mjs",
  "ops/platform/qualification-target-profile.mjs", "ops/platform/qualification-target-profiles.json",
  "ops/platform/p2-lifecycle-state-witness.mjs", "ops/platform/p2-lifecycle-persistence-probe.mjs",
  "ops/platform/p2-lifecycle-owned-source-manifest.mjs", "ops/platform/harness/owned-p2-lifecycle-persistence.mjs",
  "ops/platform/test-p2-lifecycle-persistence-local.mjs", "ops/platform/p2-lifecycle-receiver-post.mjs",
  "ops/platform/p2-lifecycle-receiver-negatives.mjs", "ops/platform/harness/owned-p2-lifecycle-receivers.mjs",
  "ops/platform/test-p2-lifecycle-receivers-local.mjs",
]);
const API_DIRECTORIES = Object.freeze(["drizzle", "src", "dist", "openapi", "contracts"]);
const API_FILES = Object.freeze(["package.json", "package-lock.json"]);
const hash = value => createHash("sha256").update(value).digest("hex");
const isSha = value => SHA.test(value) && value !== "0".repeat(64);
const demand = condition => { if (!condition) throw new Error("P2_LIFECYCLE_OWNED_SOURCE_MANIFEST_REFUSED"); };
const closed = (value, fields) => Boolean(value && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort()));

// Owned fixture pins only. Release source selection is governed separately.
const API_PAIRS = Object.freeze([
  Object.freeze({ ...API_REVISIONS, expiryFixed: false }),
  Object.freeze({ ...REHEARSAL_API_REVISIONS, expiryFixed: true }),
]);

export function selectP2LifecycleOwnedApiPair(revisions) {
  demand(closed(revisions, ["course", "community"]));
  const pair = API_PAIRS.find(({ course, community }) =>
    revisions.course === course && revisions.community === community);
  demand(pair);
  return pair;
}

function validateFileMap(value) {
  demand(value && typeof value === "object" && !Array.isArray(value));
  const names = Object.keys(value);
  demand(names.length >= 1 && names.length <= 1_500 && JSON.stringify(names) === JSON.stringify([...names].sort())
    && names.every(name => SAFE_PATH.test(name) && !name.startsWith("/") && !name.split("/").includes("..") && isSha(value[name])));
  return value;
}

export function validateP2LifecycleOwnedSourceManifest(raw) {
  const value = Buffer.isBuffer(raw) || typeof raw === "string" ? JSON.parse(raw.toString()) : structuredClone(raw);
  demand(closed(value, ["version", "status", "mode", "parentProofSha256", "identityManifestSha256", "sources"])
    && value.version === 1 && value.status === "P2_LIFECYCLE_OWNED_SOURCE_MANIFEST" && value.mode === "postgres18-container"
    && isSha(value.parentProofSha256) && isSha(value.identityManifestSha256)
    && closed(value.sources, ["frontend", "course", "community"]));
  for (const service of ["frontend", "course", "community"]) {
    const source = value.sources[service];
    demand(closed(source, ["repository", "revision", "gitTree", "packageSha256", "packageLockSha256", "artifactSha256", "files"])
      && source.repository === REPOSITORIES[service] && COMMIT.test(source.revision) && COMMIT.test(source.gitTree)
      && isSha(source.packageSha256) && isSha(source.packageLockSha256));
    if (service === "frontend") demand(closed(source.artifactSha256, []));
    else if (service === "course") demand(closed(source.artifactSha256, ["course"]) && isSha(source.artifactSha256.course));
    else demand(closed(source.artifactSha256, ["community", "enrollmentEvent"])
      && isSha(source.artifactSha256.community) && isSha(source.artifactSha256.enrollmentEvent));
    validateFileMap(source.files);
  }
  selectP2LifecycleOwnedApiPair({ course: value.sources.course.revision, community: value.sources.community.revision });
  return value;
}

function readFile(root, name) {
  demand(SAFE_PATH.test(name) && !name.split("/").includes(".."));
  let path = root;
  for (const component of name.split("/")) {
    path = join(path, component);
    demand(!lstatSync(path).isSymbolicLink());
  }
  const info = lstatSync(path);
  demand(info.isFile() && !info.isSymbolicLink() && info.size <= 16 * 1024 * 1024);
  return readFileSync(path);
}

export function readP2LifecycleOwnedContractSelection(frontendRoot, revisions) {
  const bytes = readFile(frontendRoot, P2_CONTRACT_MANIFEST), value = JSON.parse(bytes.toString());
  demand(value?.version === 1 && value.status === "released" && closed(value.artifacts, Object.keys(API_ARTIFACTS)));
  const pair = selectP2LifecycleOwnedApiPair({ course: value.artifacts.course?.revision, community: value.artifacts.community?.revision });
  if (revisions !== undefined) demand(selectP2LifecycleOwnedApiPair(revisions) === pair);
  const artifactSha256 = {};
  for (const [name, { service, sourcePath }] of Object.entries(API_ARTIFACTS)) {
    const artifact = value.artifacts[name];
    demand(artifact?.repository === REPOSITORIES[service] && artifact.revision === pair[service]
      && artifact.sourcePath === sourcePath && typeof artifact.sha256 === "string" && isSha(artifact.sha256));
    artifactSha256[name] = artifact.sha256;
  }
  return Object.freeze({ pair, manifestSha256: hash(bytes), artifactSha256: Object.freeze(artifactSha256) });
}

function walk(root, directory, output) {
  const start = join(root, ...directory.split("/")), info = lstatSync(start);
  demand(info.isDirectory() && !info.isSymbolicLink());
  for (const entry of readdirSync(start, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(start, entry.name), relativeName = relative(root, path).split(sep).join("/");
    demand(SAFE_PATH.test(relativeName) && !entry.isSymbolicLink());
    if (entry.isDirectory()) walk(root, relativeName, output);
    else { demand(entry.isFile()); output[relativeName] = hash(readFile(root, relativeName)); }
  }
}

export function p2LifecycleOwnedSourceFileMap(service, sourceRoot) {
  demand(["frontend", "course", "community"].includes(service));
  const requestedRoot = resolve(sourceRoot), requestedInfo = lstatSync(requestedRoot), root = realpathSync(requestedRoot);
  demand(requestedInfo.isDirectory() && !requestedInfo.isSymbolicLink());
  const output = {};
  const directories = service === "frontend" ? FRONTEND_DIRECTORIES : API_DIRECTORIES;
  const files = service === "frontend" ? FRONTEND_FILES : API_FILES;
  for (const directory of directories) walk(root, directory, output);
  for (const name of files) output[name] = hash(readFile(root, name));
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

export function verifyP2LifecycleOwnedSourceManifest(raw, roots) {
  const manifest = validateP2LifecycleOwnedSourceManifest(raw);
  demand(closed(roots, ["frontend", "course", "community"]));
  const selection = readP2LifecycleOwnedContractSelection(roots.frontend,
    { course: manifest.sources.course.revision, community: manifest.sources.community.revision });
  for (const service of ["frontend", "course", "community"]) {
    const source = manifest.sources[service], actual = p2LifecycleOwnedSourceFileMap(service, roots[service]);
    demand(JSON.stringify(actual) === JSON.stringify(source.files)
      && source.packageSha256 === actual["package.json"] && source.packageLockSha256 === actual["package-lock.json"]);
    for (const [name, { service: owner, sourcePath }] of Object.entries(API_ARTIFACTS))
      if (owner === service) demand(source.artifactSha256[name] === actual[sourcePath] &&
        source.artifactSha256[name] === selection.artifactSha256[name]);
  }
  demand(manifest.identityManifestSha256 === selection.manifestSha256 &&
    manifest.identityManifestSha256 === manifest.sources.frontend.files[P2_CONTRACT_MANIFEST]);
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(typeof raw === "string" ? raw : JSON.stringify(raw));
  return Object.freeze({ manifest, apiPair: selection.pair, sourceManifestSha256: hash(bytes) });
}

export const P2_LIFECYCLE_OWNED_API_REVISIONS = API_REVISIONS;
export const P2_LIFECYCLE_OWNED_REHEARSAL_API_REVISIONS = REHEARSAL_API_REVISIONS;
export const P2_LIFECYCLE_OWNED_SOURCE_CLOSURE = Object.freeze({
  frontend: Object.freeze({ directories: FRONTEND_DIRECTORIES, files: FRONTEND_FILES }),
  api: Object.freeze({ directories: API_DIRECTORIES, files: API_FILES }),
});
