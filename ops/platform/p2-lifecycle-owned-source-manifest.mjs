import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_PATH = /^[A-Za-z0-9_./-]{1,240}$/u;
const API_REVISIONS = Object.freeze({
  course: "a447bfde20299e12afab68a3331b3792ddd07598",
  community: "939de65dd52f0b1a43993a25c7c428dce6e2bb43",
});
const REPOSITORIES = Object.freeze({
  frontend: "lash-her-frontend",
  course: "lash-her-course-api",
  community: "lash-her-community-api",
});
const FRONTEND_DIRECTORIES = Object.freeze(["drizzle", "contracts/api-integration/p2-candidate"]);
const FRONTEND_FILES = Object.freeze([
  "package.json", "package-lock.json", "contracts/api-integration/v1/manifest.json",
  "src/lib/private-db/migration-lineage.ts", "scripts/api-contract-compatibility-review.mjs", "scripts/api-contract-tools.mjs",
  "ops/platform/frontend-migration.mjs", "ops/platform/frontend-schema.mjs", "ops/platform/source-checkout.mjs",
  "ops/platform/release.mjs", "ops/platform/release-inputs.mjs", "ops/platform/source-policy.mjs",
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
  demand(value.sources.course.revision === API_REVISIONS.course && value.sources.community.revision === API_REVISIONS.community);
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
  for (const service of ["frontend", "course", "community"]) {
    const source = manifest.sources[service], actual = p2LifecycleOwnedSourceFileMap(service, roots[service]);
    demand(JSON.stringify(actual) === JSON.stringify(source.files)
      && source.packageSha256 === actual["package.json"] && source.packageLockSha256 === actual["package-lock.json"]);
    if (service === "course") demand(source.artifactSha256.course === actual["openapi/course-api.json"]);
    if (service === "community") demand(source.artifactSha256.community === actual["openapi/community-api.json"]
      && source.artifactSha256.enrollmentEvent === actual["contracts/course-enrollment/v1/enrollment-event.schema.json"]);
  }
  demand(manifest.identityManifestSha256 === manifest.sources.frontend.files["contracts/api-integration/p2-candidate/manifest.json"]);
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(typeof raw === "string" ? raw : JSON.stringify(raw));
  return Object.freeze({ manifest, sourceManifestSha256: hash(bytes) });
}

export const P2_LIFECYCLE_OWNED_API_REVISIONS = API_REVISIONS;
export const P2_LIFECYCLE_OWNED_SOURCE_CLOSURE = Object.freeze({
  frontend: Object.freeze({ directories: FRONTEND_DIRECTORIES, files: FRONTEND_FILES }),
  api: Object.freeze({ directories: API_DIRECTORIES, files: API_FILES }),
});
