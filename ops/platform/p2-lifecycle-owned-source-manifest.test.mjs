import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  P2_LIFECYCLE_OWNED_API_REVISIONS,
  P2_LIFECYCLE_OWNED_SOURCE_CLOSURE,
  p2LifecycleOwnedSourceFileMap,
  verifyP2LifecycleOwnedSourceManifest,
} from "./p2-lifecycle-owned-source-manifest.mjs";

const sha = digit => digit.repeat(64), commit = digit => digit.repeat(40);
function file(root, name, body = name) { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), body); }
function source(root, service) {
  const closure = service === "frontend" ? P2_LIFECYCLE_OWNED_SOURCE_CLOSURE.frontend : P2_LIFECYCLE_OWNED_SOURCE_CLOSURE.api;
  for (const directory of closure.directories) { file(root, `${directory}/README.md`); file(root, `${directory}/owned.txt`); }
  for (const name of closure.files) file(root, name);
  if (service === "frontend") file(root, "contracts/api-integration/p2-candidate/manifest.json", "manifest");
  if (service !== "frontend") {
    file(root, "openapi/course-api.json", "course"); file(root, "openapi/community-api.json", "community");
    file(root, "contracts/course-enrollment/v1/enrollment-event.schema.json", "event");
  }
}
function manifest(roots) {
  const files = Object.fromEntries(Object.entries(roots).map(([service, root]) => [service, p2LifecycleOwnedSourceFileMap(service, root)]));
  return { version: 1, status: "P2_LIFECYCLE_OWNED_SOURCE_MANIFEST", mode: "postgres18-container", parentProofSha256: sha("1"),
    identityManifestSha256: files.frontend["contracts/api-integration/p2-candidate/manifest.json"],
    sources: {
      frontend: { repository: "lash-her-frontend", revision: commit("a"), gitTree: commit("1"), packageSha256: files.frontend["package.json"],
        packageLockSha256: files.frontend["package-lock.json"], artifactSha256: {}, files: files.frontend },
      course: { repository: "lash-her-course-api", revision: P2_LIFECYCLE_OWNED_API_REVISIONS.course, gitTree: commit("2"), packageSha256: files.course["package.json"],
        packageLockSha256: files.course["package-lock.json"], artifactSha256: { course: files.course["openapi/course-api.json"] }, files: files.course },
      community: { repository: "lash-her-community-api", revision: P2_LIFECYCLE_OWNED_API_REVISIONS.community, gitTree: commit("3"), packageSha256: files.community["package.json"],
        packageLockSha256: files.community["package-lock.json"], artifactSha256: { community: files.community["openapi/community-api.json"],
          enrollmentEvent: files.community["contracts/course-enrollment/v1/enrollment-event.schema.json"] }, files: files.community },
    } };
}

test("fixed PG18 manifest verifies exact mounted frontend and API closures", () => {
  const directory = mkdtempSync(join(tmpdir(), "p2-lifecycle-source-manifest-"));
  try {
    const roots = Object.fromEntries(["frontend", "course", "community"].map(service => { const root = join(directory, service); mkdirSync(root); source(root, service); return [service, root]; }));
    const value = manifest(roots), raw = Buffer.from(JSON.stringify(value));
    const verified = verifyP2LifecycleOwnedSourceManifest(raw, roots);
    assert.equal(verified.manifest.sources.course.revision, P2_LIFECYCLE_OWNED_API_REVISIONS.course);
    assert.match(verified.sourceManifestSha256, /^[a-f0-9]{64}$/u);
    for (const service of ["frontend", "course", "community"]) {
      const names = Object.keys(verified.manifest.sources[service].files);
      assert.deepEqual(names, [...names].sort());
    }

    file(roots.course, "src/owned.txt", "changed");
    assert.throws(() => verifyP2LifecycleOwnedSourceManifest(raw, roots), /P2_LIFECYCLE_OWNED_SOURCE_MANIFEST_REFUSED/u);
    file(roots.course, "src/owned.txt"); file(roots.community, "dist/unlisted.js");
    assert.throws(() => verifyP2LifecycleOwnedSourceManifest(raw, roots), /P2_LIFECYCLE_OWNED_SOURCE_MANIFEST_REFUSED/u);
    rmSync(join(roots.community, "dist/unlisted.js")); symlinkSync("owned.txt", join(roots.community, "dist/link.js"));
    assert.throws(() => verifyP2LifecycleOwnedSourceManifest(raw, roots), /P2_LIFECYCLE_OWNED_SOURCE_MANIFEST_REFUSED/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("manifest refuses wrong revisions, unordered maps and extra authority fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "p2-lifecycle-source-manifest-shape-"));
  try {
    const roots = Object.fromEntries(["frontend", "course", "community"].map(service => { const root = join(directory, service); mkdirSync(root); source(root, service); return [service, root]; }));
    for (const change of [
      value => { value.sources.course.revision = commit("f"); },
      value => { value.command = ["git", "clone"]; },
      value => { value.sources.frontend.files = Object.fromEntries(Object.entries(value.sources.frontend.files).reverse()); },
      value => { value.parentProofSha256 = "0".repeat(64); },
    ]) {
      const value = manifest(roots); change(value);
      assert.throws(() => verifyP2LifecycleOwnedSourceManifest(Buffer.from(JSON.stringify(value)), roots), /P2_LIFECYCLE_OWNED_SOURCE_MANIFEST_REFUSED/u);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("source closure refuses symlinked roots and fixed-file parent directories", () => {
  const directory = mkdtempSync(join(tmpdir(), "p2-lifecycle-source-manifest-links-"));
  try {
    const root = join(directory, "frontend"); mkdirSync(root); source(root, "frontend");
    const rootLink = join(directory, "frontend-link"); symlinkSync(root, rootLink);
    assert.throws(() => p2LifecycleOwnedSourceFileMap("frontend", rootLink), /P2_LIFECYCLE_OWNED_SOURCE_MANIFEST_REFUSED/u);

    const scripts = join(root, "scripts"), scriptsReal = join(root, "scripts-real");
    mkdirSync(scriptsReal); writeFileSync(join(scriptsReal, "api-contract-compatibility-review.mjs"), "review");
    writeFileSync(join(scriptsReal, "api-contract-tools.mjs"), "tools");
    rmSync(scripts, { recursive: true }); symlinkSync(scriptsReal, scripts);
    assert.throws(() => p2LifecycleOwnedSourceFileMap("frontend", root), /P2_LIFECYCLE_OWNED_SOURCE_MANIFEST_REFUSED/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
