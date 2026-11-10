import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, cpSync, copyFileSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { writePackagedFrontendSource, verifyPackagedFrontendSource } from "./frontend-image-source.mjs";
import { frontendMigrationArtifact } from "./frontend-migration.mjs";
import { sha256 } from "../../scripts/api-contract-tools.mjs";

const source = resolve(fileURLToPath(new URL("../..", import.meta.url)));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "frontend-image-source-"));
  for (const directory of ["ops/platform", "scripts", "src/lib/private-db", "contracts/api-integration/v1"]) mkdirSync(join(root, directory), { recursive: true });
  for (const file of ["api-contract-tools.mjs", "api-contract-compatibility-review.mjs"]) copyFileSync(join(source, "scripts", file), join(root, "scripts", file));
  for (const name of ["frontend-migration", "frontend-schema", "frontend-image", "frontend-image-source", "source-checkout", "release-inputs",
    "source-policy", "release", "p2-profiled-current-probe", "p2-recovery-current-probe", "p2-frontend-replacement-probe",
    "p2-frontend-replacement-abort", "p2-frontend-replacement-written", "p2-frontend-replacement-closed", "frontend-admission-bootstrap"])
    copyFileSync(join(source, `ops/platform/${name}.mjs`), join(root, `ops/platform/${name}.mjs`));
  for (const name of ["qualification-target-profile.mjs", "qualification-target-profiles.json"])
    copyFileSync(join(source, "ops/platform", name), join(root, "ops/platform", name));
  for (const name of ["package.json", "package-lock.json"]) copyFileSync(join(source, "ops/platform/frontend-migration-deps", name), join(root, name));
  for (const name of ["src/lib/private-db/migration-lineage.ts", "contracts/api-integration/v1/manifest.json"]) copyFileSync(join(source, name), join(root, name));
  cpSync(join(source, "contracts/api-integration/p2-candidate"), join(root, "contracts/api-integration/p2-candidate"), { recursive: true });
  cpSync(join(source, "drizzle"), join(root, "drizzle"), { recursive: true });
  return root;
}

test("packaged source binds the migration executable, SQL, lineage and minimal dependencies", () => {
  const root = fixture();
  try {
    const manifest = writePackagedFrontendSource("a".repeat(40), root);
    assert.equal(verifyPackagedFrontendSource(root, "a".repeat(40)).commit, manifest.commit);
    assert.ok(manifest.files["ops/platform/frontend-migration.mjs"]);
    assert.ok(manifest.files["src/lib/private-db/migration-lineage.ts"]);
    assert.ok(manifest.files["package-lock.json"]);
    assert.throws(() => verifyPackagedFrontendSource(root, "b".repeat(40)));
    assert.throws(() => writePackagedFrontendSource("a".repeat(40), root));
    writeFileSync(join(root, "ops/platform/frontend-migration.mjs"), "changed");
    assert.throws(() => verifyPackagedFrontendSource(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("packaged physical probes bind their executable source and dependencies", () => {
  const root = fixture();
  try {
    const manifest = writePackagedFrontendSource("a".repeat(40), root);
    for (const name of ["p2-profiled-current-probe", "p2-recovery-current-probe", "p2-frontend-replacement-probe",
      "p2-frontend-replacement-abort", "p2-frontend-replacement-written", "p2-frontend-replacement-closed", "frontend-admission-bootstrap"]) {
      const path = `ops/platform/${name}.mjs`;
      assert.equal(manifest.files[path], sha256(readFileSync(join(source, path))));
    }
    assert.doesNotThrow(() => verifyPackagedFrontendSource(root));
    writeFileSync(join(root, "ops/platform/p2-frontend-replacement-probe.mjs"), "modified replacement observer\n");
    assert.throws(() => verifyPackagedFrontendSource(root));
    copyFileSync(join(source, "ops/platform/p2-frontend-replacement-probe.mjs"), join(root, "ops/platform/p2-frontend-replacement-probe.mjs"));
    writeFileSync(join(root, "ops/platform/p2-frontend-replacement-abort.mjs"), "modified replacement abort\n");
    assert.throws(() => verifyPackagedFrontendSource(root));
    copyFileSync(join(source, "ops/platform/p2-frontend-replacement-abort.mjs"), join(root, "ops/platform/p2-frontend-replacement-abort.mjs"));
    writeFileSync(join(root, "ops/platform/p2-frontend-replacement-closed.mjs"), "modified replacement closure\n");
    assert.throws(() => verifyPackagedFrontendSource(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("extra SQL or omitted source cannot silently enter a packaged image", () => {
  for (const mode of ["extra", "omitted"]) {
    const root = fixture();
    try {
      writePackagedFrontendSource("a".repeat(40), root);
      if (mode === "extra") writeFileSync(join(root, "drizzle/9999_unapproved.sql"), "select 1;");
      else rmSync(join(root, "src/lib/private-db/migration-lineage.ts"));
      assert.throws(() => verifyPackagedFrontendSource(root));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

for (const name of ["qualification-target-profile.mjs", "qualification-target-profiles.json"]) {
  test(`packaged image binds the original qualification selector ${name}`, () => {
    for (const mode of ["modified", "omitted", "unlisted"]) {
      const root = fixture(), file = `ops/platform/${name}`;
      try {
        const manifest = writePackagedFrontendSource("a".repeat(40), root);
        assert.equal(manifest.files[file], sha256(readFileSync(join(source, file))));
        if (mode === "modified") writeFileSync(join(root, file), "changed\n");
        else if (mode === "omitted") rmSync(join(root, file));
        else {
          delete manifest.files[file];
          rmSync(join(root, "migration-source.json"));
          writeFileSync(join(root, "migration-source.json"), JSON.stringify(manifest) + "\n");
        }
        assert.throws(() => verifyPackagedFrontendSource(root));
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
    assert.ok(readFileSync(join(source, "ops/platform/Dockerfile.frontend-migration"), "utf8").includes(
      "COPY ops/platform/qualification-target-profile.mjs ops/platform/qualification-target-profiles.json ./ops/platform/"));
  });
}

for (const file of ["manifest.json", "course-api.json", "community-api.json", "enrollment-event.schema.json", "boundary-contracts.json", "README.md"]) {
  test(`packaged image refuses modified P2 ${file}`, () => {
    const root = fixture();
    try {
      const manifest = writePackagedFrontendSource("a".repeat(40), root), path = `contracts/api-integration/p2-candidate/${file}`;
      assert.ok(manifest.files[path]); assert.doesNotThrow(() => verifyPackagedFrontendSource(root));
      writeFileSync(join(root, path), "modified\n");
      assert.throws(() => verifyPackagedFrontendSource(root));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("released P2 image source requires and binds the fixed compatibility review and verifier source", () => {
  const root = fixture(), bundle = join(root, "contracts/api-integration/p2-candidate");
  try {
    const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json")));
    manifest.status = "released"; manifest.readmeSha256 = sha256(readFileSync(join(bundle, "README.md")));
    const bytes = JSON.stringify(manifest) + "\n"; writeFileSync(join(bundle, "manifest.json"), bytes);
    rmSync(join(bundle, "compatibility-review.json"), { force: true });
    assert.throws(() => writePackagedFrontendSource("a".repeat(40), root));
    const review = { version: 1, kind: "integration-contract-compatibility-review",
      baseline: { revision: "a".repeat(40), bundlePath: "contracts/api-integration/v1", manifestSha256: "b".repeat(64) },
      candidate: { manifestSha256: sha256(bytes) }, changes: [], versionedDocuments: {
        enrollmentEvent: { beforeSha256: manifest.artifacts.enrollmentEvent.sha256, afterSha256: manifest.artifacts.enrollmentEvent.sha256, classification: "unchanged" },
        boundaries: { beforeSha256: manifest.boundarySha256, afterSha256: manifest.boundarySha256, classification: "unchanged" },
      } };
    writeFileSync(join(bundle, "compatibility-review.json"), JSON.stringify(review) + "\n");
    const packaged = writePackagedFrontendSource("a".repeat(40), root);
    assert.ok(packaged.files["contracts/api-integration/p2-candidate/compatibility-review.json"]);
    assert.ok(packaged.files["scripts/api-contract-compatibility-review.mjs"]);
    assert.ok(packaged.files["scripts/api-contract-tools.mjs"]);
    assert.doesNotThrow(() => verifyPackagedFrontendSource(root));
    writeFileSync(join(bundle, "compatibility-review.json"), JSON.stringify(review) + " \n");
    assert.throws(() => verifyPackagedFrontendSource(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("minimal image dependencies stay aligned with the application lock", () => {
  const isolated = JSON.parse(readFileSync(join(source, "ops/platform/frontend-migration-deps/package-lock.json")));
  const app = JSON.parse(readFileSync(join(source, "package-lock.json")));
  for (const name of ["pg", "drizzle-orm"]) assert.equal(isolated.packages[`node_modules/${name}`].version, app.packages[`node_modules/${name}`].version);
  assert.deepEqual(Object.keys(isolated.packages[""].dependencies).sort(), ["drizzle-orm", "pg"]);
  assert.ok(frontendMigrationArtifact().migrations.length > 0);
  assert.ok(readFileSync(join(source, "ops/platform/Dockerfile.frontend-migration"), "utf8").includes("COPY contracts/api-integration/p2-candidate/ ./contracts/api-integration/p2-candidate/"));
  assert.ok(readFileSync(join(source, ".github/workflows/ci.yml"), "utf8").includes("contracts/api-integration/p2-candidate,dst=/source/contracts/api-integration/p2-candidate,readonly"));
  assert.ok(readFileSync(join(source, ".github/workflows/ci.yml"), "utf8").includes("verifyPublishedPhase2Contracts(process.cwd(), process.env.FRONTEND_SOURCE_REVISION)"));
});

test("image entrypoint never offers checkout or environment source-verification bypasses", () => {
  // The real entrypoint refuses outside an image before inspecting job inputs.
  for (const mode of ["--manifest-only", "--observe-replacement-lock", "--abort-replacement",
    "--observe-replacement-written", "--observe-replacement-closed"]) {
    const result = spawnSync(process.execPath, ["ops/platform/frontend-image.mjs", mode], {
      cwd: source, input: "{}", encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH },
    });
    assert.equal(result.status, 1); assert.match(result.stderr, /FRONTEND_PACKAGED_SOURCE_REFUSED/u);
  }
});
