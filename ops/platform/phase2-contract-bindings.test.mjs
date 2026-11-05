import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { phase2ContractManifestBinding } from "./release.mjs";
import { verifySourceCheckouts } from "./source-checkout.mjs";
import { buildCompatibilityReview, readReviewBundle, readReviewBundleAtRevision } from "../../scripts/api-contract-compatibility-review.mjs";

const frontend = fileURLToPath(new URL("../..", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "phase2-contract-source-")), sources = {};
  const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  const commit = repo => {
    git(repo, "add", ".");
    git(repo, "-c", "user.name=Owned fixture", "-c", "user.email=owned@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-gpg-sign", "-m", "Owned P2 source fixture");
    return git(repo, "rev-parse", "HEAD");
  };
  const source = join(directory, "lash-her-frontend"), bundle = join(source, "contracts/api-integration/p2-candidate");
  mkdirSync(bundle, { recursive: true });
  cpSync(join(frontend, "contracts/api-integration/p2-candidate"), bundle, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json")));
  manifest.status = "released";
  manifest.readmeSha256 = hash(readFileSync(join(bundle, "README.md")));
  try {
    for (const name of ["course", "community"]) {
      const repo = join(directory, `lash-her-${name}-api`); mkdirSync(repo);
      git(repo, "init", "--quiet");
      for (const artifact of Object.values(manifest.artifacts).filter(item => item.repository === `lash-her-${name}-api`)) {
        const path = join(repo, artifact.sourcePath); mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, readFileSync(join(bundle, artifact.file)));
      }
      sources[name] = { repository: `https://github.com/princessdardan/lash-her-${name}-api.git`, commit: commit(repo), requiredChecks: "passed" };
    }
    for (const [name, artifact] of Object.entries(manifest.artifacts)) artifact.revision = sources[name === "enrollmentEvent" ? "community" : name].commit;
    writeFileSync(join(bundle, "manifest.json"), JSON.stringify(manifest) + "\n");
    git(source, "init", "--quiet");
    const archive = join(source, "contracts/api-integration/v1");
    cpSync(bundle, archive, { recursive: true });
    const baselineRevision = commit(source);
    const reviewPath = join(bundle, "compatibility-review.json");
    const review = buildCompatibilityReview(readReviewBundleAtRevision(source, baselineRevision), readReviewBundle(bundle), baselineRevision);
    writeFileSync(reviewPath, JSON.stringify(review) + "\n");
    sources.frontend = { repository: "https://github.com/princessdardan/lash-her-frontend.git", commit: commit(source), requiredChecks: "passed" };
    const retain = () => {
      const bytes = JSON.stringify(manifest) + "\n";
      writeFileSync(join(bundle, "manifest.json"), bytes); review.candidate.manifestSha256 = hash(bytes);
      writeFileSync(reviewPath, JSON.stringify(review) + "\n"); sources.frontend.commit = commit(source);
    };
    run({ directory, source, bundle, sources, manifest, retain, commit });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("P2 source guard binds the released manifest, every API revision and exact contract bytes", () => fixture(f => {
  const binding = verifySourceCheckouts(f.directory, f.sources, { requirePhase2: true });
  assert.equal(binding.phase2ContractManifestSha256, `sha256:${hash(readFileSync(join(f.bundle, "manifest.json")))}`);
  assert.equal(binding.phase2ContractRevisions.enrollmentEvent, f.sources.community.commit);
}));

for (const name of ["course", "community", "enrollmentEvent"]) test(`P2 source guard refuses wrong ${name} revision in an otherwise clean checkout`, () => fixture(f => {
  f.manifest.artifacts[name].revision = "b".repeat(40); f.retain();
  assert.throws(() => verifySourceCheckouts(f.directory, f.sources, { requirePhase2: true }), /phase 2/u);
}));

test("P2 source guard refuses changed API bytes even when both checkout and manifest pins were advanced", () => fixture(f => {
  writeFileSync(join(f.directory, "lash-her-course-api/openapi/course-api.json"), "{}\n");
  f.sources.course.commit = f.commit(join(f.directory, "lash-her-course-api"));
  f.manifest.artifacts.course.revision = f.sources.course.commit; f.retain();
  assert.throws(() => verifySourceCheckouts(f.directory, f.sources, { requirePhase2: true }), /API contract source/u);
}));

for (const file of ["course-api.json", "community-api.json", "enrollment-event.schema.json", "boundary-contracts.json", "README.md"]) {
  test(`P2 manifest integrity refuses changed ${file}`, () => fixture(f => {
    writeFileSync(join(f.bundle, file), "{}\n");
    assert.throws(() => phase2ContractManifestBinding(f.source));
  }));
}

test("new P2 source publication refuses candidate status and wrong or missing source-proof hash", () => fixture(f => {
  const proofPath = join(f.directory, "source-checks.json");
  const proof = { version: 4, contractPhase: "p2", phase2ContractManifestSha256: phase2ContractManifestBinding(f.source).phase2ContractManifestSha256, sources: f.sources };
  const cli = fileURLToPath(new URL("./source-checkout.mjs", import.meta.url));
  const run = () => { writeFileSync(proofPath, JSON.stringify(proof)); return spawnSync(process.execPath, [cli, "--phase2", f.directory, proofPath], { encoding: "utf8" }); };
  assert.equal(run().status, 0);
  proof.phase2ContractManifestSha256 = `sha256:${"b".repeat(64)}`; assert.equal(run().status, 1);
  delete proof.phase2ContractManifestSha256; assert.equal(run().status, 1);
  proof.phase2ContractManifestSha256 = phase2ContractManifestBinding(f.source).phase2ContractManifestSha256;
  f.manifest.status = "candidate"; f.retain(); proof.sources = f.sources;
  assert.equal(run().status, 1);
}));
