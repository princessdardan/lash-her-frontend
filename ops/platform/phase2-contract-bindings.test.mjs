import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { phase2ContractManifestBinding } from "./release.mjs";
import { verifySourceCheckouts } from "./source-checkout.mjs";
import { phase2SourceFixture as fixture } from "./phase2-contract-bindings.fixture.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

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
