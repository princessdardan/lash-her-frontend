import assert from "node:assert/strict";
import test from "node:test";
import { assertBuilderSource, assertSbom, qualifyHarness, assertCandidateSourceApproval, bindStagingCandidateProfile, ARTIFACT_COMPONENTS, verifyFrontendSchemaSummary, verifyArtifactRuntime } from "./artifact-candidate.mjs";
import { verifyReleaseInputs } from "./release-inputs.mjs";
import { sourceFixture } from "./release-inputs.fixture.mjs";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { validateRuntimeEvidence, runtimeVex, verifyRecordedRuntime } from "../gateway/runtime/verify.mjs";
import { assertSourceCheckout } from "./source-checkout.mjs";
import { frontendRehearsalFixture } from "./frontend-rehearsal.fixture.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

test("frontend CI schema evidence must match source SQL, contracts and the full owned rehearsal", () => {
  const candidate = {}, summary = frontendRehearsalFixture(candidate), artifact = candidate.frontendMigration;
  assert.equal(verifyFrontendSchemaSummary(summary, artifact, "a".repeat(40)), summary.schemaBaselineSha256);
  for (const change of [{ sqlArtifactSha256: "d".repeat(64) }, { postgresMajor: 16 }, { checks: [] }, { providerTouched: true },
    { sourceCommit: "b".repeat(40) }, { packagedCliVerified: false }]) {
    assert.throws(() => verifyFrontendSchemaSummary({ ...summary, ...change }, artifact, "a".repeat(40)));
  }
  artifact.contractPhase = summary.contractPhase = "p2";
  artifact.phase2ContractManifestSha256 = summary.phase2ContractManifestSha256 = `sha256:${"b".repeat(64)}`;
  assert.doesNotThrow(() => verifyFrontendSchemaSummary(summary, artifact, "a".repeat(40)));
  for (const value of [undefined, `sha256:${"c".repeat(64)}`]) assert.throws(() => verifyFrontendSchemaSummary({ ...summary, phase2ContractManifestSha256: value }, artifact, "a".repeat(40)));
});

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
  const report = JSON.parse(readFileSync(new URL("../../docs/api-integration/baselines/2026-11-01-runtime-release/harness.json", import.meta.url), "utf8"));
  const candidate = { approval: { state: "pending" }, artifacts: Object.fromEntries(ARTIFACT_COMPONENTS.map((component) => [component.key, { localImageId: report.images[component.local] }])) };
  const frontend = frontendRehearsalFixture(candidate);
  const qualify = (value = report, migration = frontend) => qualifyHarness(candidate, value, JSON.stringify(value), migration);
  const qualified = qualify();
  assert.equal(qualified.approval.state, "pending");
  assert.equal(qualified.integration.realVercelOidcVerified, false);
  assert.throws(() => qualify({ ...report, records: report.records.slice(1) }));
  assert.throws(() => qualify({ ...report, images: { ...report.images, gateway: `sha256:${"0".repeat(64)}` } }));
  assert.throws(() => qualify({ ...report, records: [...report.records, { name: "extra", passed: false }] }));
  assert.throws(() => qualify(report, { ...frontend, migrationImageDigest: `sha256:${"e".repeat(64)}` }));
  assert.throws(() => qualifyHarness(candidate, report));
});

test("only a qualified staging P2 publication receives the fixed profile and keeps release approval pending", () => {
  const candidate = JSON.parse(readFileSync(new URL("./release.candidate.json", import.meta.url), "utf8"));
  candidate.contractPhase = "p2";
  candidate.sources.frontend.commit = "a".repeat(40);
  candidate.buildWorkflow = { ref: "refs/heads/staging", commit: candidate.sources.frontend.commit };
  candidate.sourceApproval = { runId: "9001" };
  candidate.integration = { state: "passed" };
  candidate.frontendMigration = { sqlArtifactSha256: "f".repeat(64) };
  const original = structuredClone(candidate);
  const published = bindStagingCandidateProfile(candidate, "refs/heads/staging");
  assert.equal(published.version, 3);
  for (const carrier of [published, published.sourceApproval, published.integration, published.workload, published.approval,
    published.frontendMigration, ...Object.values(published.sources)]) assert.deepEqual(carrier.qualificationTargetProfile, profile);
  assert.deepEqual(published.artifacts, original.artifacts);
  assert.equal(published.approval.state, "pending");
  assert.equal(published.approval.approvedAt, null);
  assert.deepEqual(candidate, original);
  assert.equal(bindStagingCandidateProfile(candidate, "refs/heads/main"), candidate);
  const legacy = { ...candidate, contractPhase: undefined };
  assert.equal(bindStagingCandidateProfile(legacy, "refs/heads/staging"), legacy);
  for (const mutate of [
    (value) => { value.environment = "production"; },
    (value) => { value.workload.projectId = "prj_Foreign"; },
    (value) => { value.workload.environment = "preview"; },
    (value) => { value.buildWorkflow.commit = "b".repeat(40); },
    (value) => { value.integration.state = "pending"; },
    (value) => { value.approval.state = "approved"; },
    (value) => { value.sources.course.qualificationTargetProfile = profile; },
  ]) {
    const changed = structuredClone(candidate); mutate(changed);
    assert.throws(() => bindStagingCandidateProfile(changed, "refs/heads/staging"));
  }
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
    (p) => { delete p.phase2ContractManifestSha256; },
    (p) => { p.phase2ContractManifestSha256 = `sha256:${"b".repeat(64)}`; },
  ]) {
    const tampered = structuredClone(proof); change(tampered);
    assert.throws(() => assertCandidateSourceApproval(tampered, f.context));
  }
  assert.throws(() => assertCandidateSourceApproval(proof, { ...f.context, runId: "9002" }));
  const legacy = { ...proof, version: 3 }, legacyContext = { ...f.context };
  for (const value of [legacy, legacyContext]) for (const key of ["contractPhase", "phase2ContractManifestSha256", "phase2ContractRevisions"]) delete value[key];
  assert.doesNotThrow(() => assertCandidateSourceApproval(legacy, legacyContext));
  assert.throws(() => assertCandidateSourceApproval(legacy, legacyContext, { requirePhase2: true }));
  assert.throws(() => assertCandidateSourceApproval({ ...proof, version: 3 }, legacyContext));
});

// The fixture CLI exercises the repository-owned API interface using the shared
// evidence contract, with the API's own lock path. API repositories test their
// actual CLI and installed-library proof independently.
const apiVerifierFixture = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateQualifiedRuntimeScan } from ${JSON.stringify(new URL("../gateway/runtime/verify.mjs", import.meta.url).href)};
const hash = value => createHash('sha256').update(value).digest('hex');
${verifyRecordedRuntime.toString().replace("ops/gateway/runtime/inputs.lock.json", "ops/runtime/inputs.lock.json")}
assert.equal(process.argv.length, 7);
assert.equal(process.argv[2], '--recorded');
assert.equal(realpathSync(process.argv[6]), resolve(fileURLToPath(new URL('../../', import.meta.url))));
verifyRecordedRuntime(...process.argv.slice(3));
console.log('PATCHED_RUNTIME_RECORD_VERIFIED');
`;

function runtimeFixture(component, run, apiSource = undefined) {
  const directory = mkdtempSync(join(tmpdir(), "artifact-api-runtime-"));
  const hash = value => createHash("sha256").update(value).digest("hex");
  const lockBytes = readFileSync(apiSource ? join(apiSource, "ops/runtime/inputs.lock.json") : new URL("../gateway/runtime/inputs.lock.json", import.meta.url));
  const lock = JSON.parse(lockBytes);
  const digest = "a".repeat(64), imageId = `sha256:${digest}`;
  const image = `ghcr.io/princessdardan/${component.image}@${imageId}`;
  const product = `pkg:oci/${component.local}@sha256%3A${digest}?arch=amd64`;
  const purl = `pkg:deb/debian/zlib1g@${encodeURIComponent(lock.packageVersion)}?arch=amd64&distro=debian-13.7`;
  const sourceRoot = join(directory, "sources"), evidence = join(directory, "evidence");
  const sourceDirectory = join(sourceRoot, `lash-her-${component.source}-api`);
  mkdirSync(evidence);
  mkdirSync(sourceRoot);
  for (const source of ["course", "community"]) {
    if (apiSource && source === component.source) {
      symlinkSync(apiSource, sourceDirectory, "dir");
      continue;
    }
    const runtime = join(sourceRoot, `lash-her-${source}-api/ops/runtime`);
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, "inputs.lock.json"), lockBytes);
    writeFileSync(join(runtime, "verify.mjs"), apiVerifierFixture);
  }
  const build = { inputsLockSha256: hash(lockBytes), inputs: lock, librarySha256: digest, packageSha256: digest,
    regressionBinarySha256: digest, regression: { unpatched: "EXPECTED_ASSERTION_FAILURE", patched: "PASS", shared: "PASS", upstreamTests: "PASS" } };
  const finding = { VulnerabilityID: lock.vulnerabilities[0], PkgName: "zlib1g", InstalledVersion: lock.packageVersion,
    PkgIdentifier: { PURL: purl }, Severity: "HIGH" };
  const observed = { evidence: build, librarySha256: digest, regressionBinarySha256: digest, regressionStatus: 0, uid: 65532,
    architecture: "amd64", packageStatus: `Status: install ok installed\nVersion: ${lock.packageVersion}\n` };
  const imageRecord = { Id: imageId, RepoDigests: [image], Architecture: "amd64", Os: "linux" };
  const raw = { ArtifactName: image, Metadata: { ImageID: imageId, RepoDigests: [image], ImageConfig: { architecture: "amd64" },
    OS: { Family: "debian", Name: "13.7" } }, Results: [{ Packages: [{ Name: "zlib1g", ID: `zlib1g@${lock.packageVersion}`, Identifier: { PURL: purl } }], Vulnerabilities: [finding] }] };
  const sbom = { metadata: { component: { purl: product } }, components: [{ name: "zlib1g", version: lock.packageVersion, purl }] };
  const binding = validateRuntimeEvidence({ lock, lockSha256: hash(lockBytes), build, observed, image: imageRecord, scan: raw, sbom });
  const filtered = { ...raw, Results: [{ ExperimentalModifiedFindings: [{ Type: "vulnerability", Status: "fixed", Finding: structuredClone(finding) }] }] };
  const f = { directory: evidence, sourceRoot, sourceDirectory, image, raw, sbom, filtered, vex: runtimeVex(binding, lock),
    record: { status: "PATCHED_RUNTIME_VERIFIED", image: imageRecord, build, observed, binding } };
  const runtime = join(evidence, `${component.local}-runtime`);
  mkdirSync(runtime);
  f.retain = () => {
    const raw = JSON.stringify(f.raw), sbom = JSON.stringify(f.sbom), vex = JSON.stringify(f.vex), scan = JSON.stringify(f.filtered);
    writeFileSync(join(evidence, `${component.local}-raw-scan.json`), raw);
    writeFileSync(join(evidence, `${component.local}-scan.json`), scan);
    for (const [name, value] of Object.entries({ "sbom.json": sbom, "fixed.vex.json": vex,
      "verification.json": JSON.stringify({ ...f.record, rawScanSha256: hash(raw), sbomSha256: hash(sbom), vexSha256: hash(vex), scanSha256: hash(scan) }) })) {
      writeFileSync(join(runtime, name), value);
    }
  };
  f.verify = () => verifyArtifactRuntime(evidence, sourceRoot, component, image);
  try { f.retain(); run(f); } finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const component of ARTIFACT_COMPONENTS.filter(item => item.source !== "frontend")) {
  test(`candidate validates ${component.local} with its repository-owned runtime CLI`, () => runtimeFixture(component, f => {
    assert.doesNotThrow(f.verify);
    rmSync(join(f.sourceDirectory, "ops/runtime/verify.mjs"));
    assert.throws(f.verify);
  }));
}

const courseRuntime = ARTIFACT_COMPONENTS.find(item => item.key === "courseRuntime");
for (const [name, change] of Object.entries({
  "unrelated raw HIGH finding with recomputed hashes": f => { f.raw.Results[0].Vulnerabilities.push({ Severity: "HIGH", VulnerabilityID: "CVE-2099-9999" }); f.retain(); },
  "unresolved filtered CRITICAL finding": f => { f.filtered.Results[0].Vulnerabilities = [{ Severity: "CRITICAL" }]; f.retain(); },
  "unsupported not-affected statement with recomputed hashes": f => { f.filtered.Results[0].ExperimentalModifiedFindings[0].Status = "not_affected"; f.retain(); },
  "forged fixed package with recomputed hashes": f => { f.filtered.Results[0].ExperimentalModifiedFindings[0].Finding.PkgName = "other"; f.retain(); },
  "forged VEX with recomputed hashes": f => { f.vex.statements[0].status = "not_affected"; f.retain(); },
  "failed installed-library regression with recomputed hashes": f => { f.record.observed.regressionStatus = 134; f.retain(); },
  "different published digest with recomputed hashes": f => { f.raw.ArtifactName = `other@sha256:${"b".repeat(64)}`; f.retain(); },
  "another image proof relabelled with the candidate name": f => {
    const other = `ghcr.io/princessdardan/unrelated@sha256:${"b".repeat(64)}`;
    f.record.image.RepoDigests = [other]; f.raw.Metadata.RepoDigests = [other];
    f.sbom.metadata.component.purl = f.sbom.metadata.component.purl.replace("a".repeat(64), "b".repeat(64));
    f.record.binding.product = f.sbom.metadata.component.purl;
    f.vex = runtimeVex(f.record.binding, f.record.build.inputs); f.retain();
  },
  "another source lock while the sibling lock still matches": f => { writeFileSync(join(f.sourceDirectory, "ops/runtime/inputs.lock.json"), JSON.stringify(f.record.build.inputs)); },
  "tampered retained scan bytes": f => { writeFileSync(join(f.directory, "course-runtime-scan.json"), JSON.stringify(f.filtered) + " "); },
  "missing filtered scan": f => { rmSync(join(f.directory, "course-runtime-scan.json")); },
  "missing raw scan": f => { rmSync(join(f.directory, "course-runtime-raw-scan.json")); },
  "missing qualification record": f => { rmSync(join(f.directory, "course-runtime-runtime/verification.json")); },
  "missing runtime SBOM": f => { rmSync(join(f.directory, "course-runtime-runtime/sbom.json")); },
  "missing VEX": f => { rmSync(join(f.directory, "course-runtime-runtime/fixed.vex.json")); },
  "successful CLI without the qualification receipt": f => { writeFileSync(join(f.sourceDirectory, "ops/runtime/verify.mjs"), "console.log('OTHER_SUCCESS');\n"); },
})) test(`candidate API runtime qualification refuses ${name}`, () => runtimeFixture(courseRuntime, f => {
  assert.doesNotThrow(f.verify);
  change(f);
  assert.throws(f.verify);
}));

// Opt-in source integration: explicit directories and commits are required, and
// the actual API checkouts are read-only. Default source CI uses the fixture CLI.
for (const component of ARTIFACT_COMPONENTS.filter(item => item.source !== "frontend")) {
  const key = component.source.toUpperCase();
  const source = process.env[`PLATFORM_TEST_${key}_SOURCE`], commit = process.env[`PLATFORM_TEST_${key}_COMMIT`];
  if (!source && !commit) continue;
  test(`candidate checks actual pinned ${component.local} CLI and refuses wrong source, absent digest and missing proof`, () => {
    assert.ok(source);
    const apiSource = resolve(source);
    assertSourceCheckout(apiSource, commit);
    runtimeFixture(component, f => {
      const cli = join(apiSource, "ops/runtime/verify.mjs");
      assert.equal(execFileSync(process.execPath, [cli, "--recorded", f.directory, component.local, f.image, f.sourceDirectory],
        { encoding: "utf8", stdio: "pipe" }).trim(), "PATCHED_RUNTIME_RECORD_VERIFIED");
      assert.doesNotThrow(f.verify);
      const wrongRoot = join(f.directory, "wrong-sources"), wrongRuntime = join(wrongRoot, `lash-her-${component.source}-api/ops/runtime`);
      mkdirSync(wrongRuntime, { recursive: true });
      copyFileSync(cli, join(wrongRuntime, "verify.mjs"));
      writeFileSync(join(wrongRuntime, "inputs.lock.json"), JSON.stringify(f.record.build.inputs));
      assert.throws(() => verifyArtifactRuntime(f.directory, wrongRoot, component, f.image));
      const digests = f.record.image.RepoDigests;
      f.record.image.RepoDigests = []; f.retain();
      assert.throws(f.verify);
      f.record.image.RepoDigests = digests; f.retain();
      assert.doesNotThrow(f.verify);
      rmSync(join(f.directory, `${component.local}-runtime/fixed.vex.json`));
      assert.throws(f.verify);
    }, apiSource);
    assertSourceCheckout(apiSource, commit);
  });
}
