import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  P2_LIFECYCLE_OWNED_API_REVISIONS,
  P2_LIFECYCLE_OWNED_FINAL_API_REVISIONS,
  P2_LIFECYCLE_OWNED_REHEARSAL_API_REVISIONS,
  P2_LIFECYCLE_OWNED_SOURCE_CLOSURE,
  p2LifecycleOwnedSourceFileMap,
  selectP2LifecycleOwnedApiPair,
  verifyP2LifecycleOwnedSourceManifest,
} from "./p2-lifecycle-owned-source-manifest.mjs";

const sha = digit => digit.repeat(64), commit = digit => digit.repeat(40);
const digest = value => createHash("sha256").update(value).digest("hex");
const contractPath = "contracts/api-integration/p2-candidate/manifest.json";
function file(root, name, body = name) { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), body); }
function contract(revisions) {
  return { version: 1, status: "released", artifacts: {
    course: { repository: "lash-her-course-api", revision: revisions.course, sourcePath: "openapi/course-api.json", sha256: digest("course") },
    community: { repository: "lash-her-community-api", revision: revisions.community, sourcePath: "openapi/community-api.json", sha256: digest("community") },
    enrollmentEvent: { repository: "lash-her-community-api", revision: revisions.community,
      sourcePath: "contracts/course-enrollment/v1/enrollment-event.schema.json", sha256: digest("event") },
  } };
}
function source(root, service) {
  const closure = service === "frontend" ? P2_LIFECYCLE_OWNED_SOURCE_CLOSURE.frontend : P2_LIFECYCLE_OWNED_SOURCE_CLOSURE.api;
  for (const directory of closure.directories) { file(root, `${directory}/README.md`); file(root, `${directory}/owned.txt`); }
  for (const name of closure.files) file(root, name);
  if (service === "frontend") file(root, contractPath, JSON.stringify(contract(P2_LIFECYCLE_OWNED_API_REVISIONS)));
  if (service !== "frontend") {
    file(root, "openapi/course-api.json", "course"); file(root, "openapi/community-api.json", "community");
    file(root, "contracts/course-enrollment/v1/enrollment-event.schema.json", "event");
  }
}
function manifest(roots, revisions = P2_LIFECYCLE_OWNED_API_REVISIONS) {
  const files = Object.fromEntries(Object.entries(roots).map(([service, root]) => [service, p2LifecycleOwnedSourceFileMap(service, root)]));
  return { version: 1, status: "P2_LIFECYCLE_OWNED_SOURCE_MANIFEST", mode: "postgres18-container", parentProofSha256: sha("1"),
    identityManifestSha256: files.frontend[contractPath],
    sources: {
      frontend: { repository: "lash-her-frontend", revision: commit("a"), gitTree: commit("1"), packageSha256: files.frontend["package.json"],
        packageLockSha256: files.frontend["package-lock.json"], artifactSha256: {}, files: files.frontend },
      course: { repository: "lash-her-course-api", revision: revisions.course, gitTree: commit("2"), packageSha256: files.course["package.json"],
        packageLockSha256: files.course["package-lock.json"], artifactSha256: { course: files.course["openapi/course-api.json"] }, files: files.course },
      community: { repository: "lash-her-community-api", revision: revisions.community, gitTree: commit("3"), packageSha256: files.community["package.json"],
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
    assert.deepEqual(verified.apiPair, { ...P2_LIFECYCLE_OWNED_API_REVISIONS, expiryFixed: false });
    for (const name of ["qualification-target-profile.mjs", "qualification-target-profiles.json"])
      assert.ok(verified.manifest.sources.frontend.files[`ops/platform/${name}`]);
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

test("owned source policy accepts only the exact historical, rehearsal, and final pairs", () => {
  const pairs = [P2_LIFECYCLE_OWNED_API_REVISIONS, P2_LIFECYCLE_OWNED_REHEARSAL_API_REVISIONS, P2_LIFECYCLE_OWNED_FINAL_API_REVISIONS];
  for (const coursePair of pairs) {
    for (const communityPair of pairs) {
      const selection = { course: coursePair.course, community: communityPair.community };
      if (coursePair === communityPair) {
        assert.deepEqual(selectP2LifecycleOwnedApiPair(selection), { ...selection, expiryFixed: coursePair !== pairs[0] });
      } else {
        assert.throws(() => selectP2LifecycleOwnedApiPair(selection), /P2_LIFECYCLE_OWNED_SOURCE_MANIFEST_REFUSED/u);
      }
    }
  }
});

test("corrected Course rehearsal requires matching mounted pins and artifact digests", () => {
  const directory = mkdtempSync(join(tmpdir(), "p2-lifecycle-source-rehearsal-"));
  try {
    const roots = Object.fromEntries(["frontend", "course", "community"].map(service => {
      const root = join(directory, service); mkdirSync(root); source(root, service); return [service, root];
    }));
    const revisions = P2_LIFECYCLE_OWNED_REHEARSAL_API_REVISIONS;
    const selected = contract(revisions);
    const writeContract = value => file(roots.frontend, contractPath, JSON.stringify(value));
    const verify = (value = manifest(roots, revisions)) => verifyP2LifecycleOwnedSourceManifest(value, roots);
    writeContract(selected);
    assert.deepEqual(verify().apiPair, { ...revisions, expiryFixed: true });
    assert.throws(() => verify({ ...manifest(roots, revisions), identityManifestSha256: sha("e") }),
      /P2_LIFECYCLE_OWNED_SOURCE_MANIFEST_REFUSED/u);
    assert.throws(() => verify(manifest(roots, { ...revisions, community: P2_LIFECYCLE_OWNED_API_REVISIONS.community })),
      /P2_LIFECYCLE_OWNED_SOURCE_MANIFEST_REFUSED/u);
    for (const mutate of [
      value => { value.artifacts.enrollmentEvent.revision = P2_LIFECYCLE_OWNED_API_REVISIONS.community; },
      value => { value.artifacts.course.sha256 = sha("f"); },
    ]) {
      const value = structuredClone(selected); mutate(value); writeContract(value);
      assert.throws(() => verify(), /P2_LIFECYCLE_OWNED_SOURCE_MANIFEST_REFUSED/u);
    }
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
