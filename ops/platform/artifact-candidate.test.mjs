import assert from "node:assert/strict";
import test from "node:test";
import { assertBuilderSource, assertSbom, qualifyHarness, assertCandidateSourceApproval, ARTIFACT_COMPONENTS } from "./artifact-candidate.mjs";
import { verifyReleaseInputs } from "./release-inputs.mjs";
import { sourceFixture } from "./release-inputs.fixture.mjs";
import { readFileSync } from "node:fs";

test("builder evidence requires the exact repository and source revision", () => {
  const sha = "a".repeat(40), repository = "https://github.com/princessdardan/lash-her-course-api.git";
  const proof = { SLSA: { materials: [{ uri: `git+${repository}#${sha}`, digest: { sha1: sha } }] } };
  assert.doesNotThrow(() => assertBuilderSource(proof, repository, sha));
  assert.throws(() => assertBuilderSource(proof, repository, "b".repeat(40)));
  assert.throws(() => assertBuilderSource(proof, "https://github.com/princessdardan/lash-her-community-api.git", sha));
  assert.throws(() => assertBuilderSource({ SLSA: { materials: [{ uri: `${repository}.attacker.invalid`, digest: { sha1: sha } }] } }, repository, sha));
  assert.throws(() => assertBuilderSource({}, repository, sha));
});

test("empty or unrelated attestation metadata cannot stand in for an SBOM", () => {
  assert.doesNotThrow(() => assertSbom({ SPDX: { spdxVersion: "SPDX-2.3", packages: [{ name: "node" }] } }));
  for (const value of [null, {}, { SPDX: { spdxVersion: "SPDX-2.3", packages: [] } }, { packages: [{ name: "node" }] }]) assert.throws(() => assertSbom(value));
});

test("harness qualification requires the exact candidate bytes and never asserts real OIDC or approval", () => {
  const report = JSON.parse(readFileSync(new URL("../../docs/api-integration/baselines/2026-10-29-p1-platform/harness.json", import.meta.url), "utf8"));
  const candidate = { approval: { state: "pending" }, artifacts: Object.fromEntries(ARTIFACT_COMPONENTS.map((component) => [component.key, { localImageId: report.images[component.local] }])) };
  const qualified = qualifyHarness(candidate, report);
  assert.equal(qualified.approval.state, "pending");
  assert.equal(qualified.integration.realVercelOidcVerified, false);
  assert.throws(() => qualifyHarness(candidate, { ...report, records: report.records.slice(1) }));
  assert.throws(() => qualifyHarness(candidate, { ...report, images: { ...report.images, gateway: `sha256:${"0".repeat(64)}` } }));
  assert.throws(() => qualifyHarness(candidate, { ...report, records: [...report.records, { name: "extra", passed: false }] }));
});

test("candidate collection and final qualification bind the operator dispatch, source and CI receipt", async () => {
  const f = sourceFixture(), proof = await verifyReleaseInputs(f.options);
  assert.equal(assertCandidateSourceApproval(proof, f.context).runId, f.context.runId);
  for (const change of [
    (p) => { p.sourceApproval.operatorGithubUserId = "123"; },
    (p) => { p.sourceApproval.runAttempt = 2; },
    (p) => { p.sources.course.commit = "b".repeat(40); },
    (p) => { p.contractManifestSha256 = `sha256:${"0".repeat(64)}`; },
    (p) => { p.sources.course.requiredChecks = "pending"; },
  ]) {
    const tampered = structuredClone(proof); change(tampered);
    assert.throws(() => assertCandidateSourceApproval(tampered, f.context));
  }
  assert.throws(() => assertCandidateSourceApproval(proof, { ...f.context, runId: "9002" }));
});
