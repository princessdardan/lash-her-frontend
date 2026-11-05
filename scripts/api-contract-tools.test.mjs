import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, cp, readFile, writeFile, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import {
  assertCompatible,
  readContractBundle,
  contractDirectory,
  sha256,
  verifyBundleRevision,
  verifySources,
} from "./api-contract-tools.mjs";
import {
  buildCompatibilityReview, readReviewBundle, readReviewBundleAtRevision,
  validateCompatibilityReview, verifyCompatibilityReview, verifyPublishedPhase2Contracts,
} from "./api-contract-compatibility-review.mjs";

test("the bundle has immutable revision/hash pins; candidate release checks fail closed", async () => {
  const { manifest, documents } = await readContractBundle();
  assert.ok(["candidate", "released"].includes(manifest.status));
  assert.ok(documents.course.paths["/v1/courses"]);
  const directory = await mkdtemp(resolve(tmpdir(), "lash-her-candidate-"));
  try {
    await cp(contractDirectory, directory, { recursive: true });
    await writeFile(
      resolve(directory, "manifest.json"),
      JSON.stringify({ ...manifest, status: "candidate" }),
    );
    const release = spawnSync(
      process.execPath,
      ["scripts/check-api-contracts.mjs", "--bundle", directory, "--release"],
      { encoding: "utf8" },
    );
    assert.notEqual(release.status, 0);
    assert.match(
      release.stderr,
      /Candidate contracts cannot certify a release/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("changed vendored bytes fail integrity checking", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "lash-her-contract-"));
  try {
    await cp(contractDirectory, directory, { recursive: true });
    await writeFile(resolve(directory, "course-api.json"), "{}\n");
    await assert.rejects(readContractBundle(directory), /hash mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("released checks require source verification and an explicit baseline", async () => {
  const fixtureDirectory = await mkdtemp(
    resolve(tmpdir(), "lash-her-release-contract-"),
  );
  const directory = resolve(fixtureDirectory, "bundle");
  const sources = resolve(fixtureDirectory, "sources");
  try {
    await cp(contractDirectory, directory, { recursive: true });
    const file = resolve(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.status = "released"; // Test-only initial approved-baseline fixture.
    manifest.readmeSha256 = sha256(
      await readFile(resolve(directory, "README.md")),
    );
    // Unit tests own their immutable source repositories. They must not depend
    // on a developer's sibling checkouts or private repository credentials.
    const sourceGit = (cwd, ...args) => execFileSync("git", [
      "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
      "-c", "user.name=Contract Tests", "-c", "user.email=contracts@example.test",
      ...args,
    ], { cwd, encoding: "utf8" });
    for (const pin of Object.values(manifest.artifacts)) {
      const target = resolve(sources, pin.repository, pin.sourcePath);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve(directory, pin.file), target);
    }
    for (const repository of new Set(Object.values(manifest.artifacts).map((pin) => pin.repository))) {
      const cwd = resolve(sources, repository);
      sourceGit(cwd, "init", "--quiet"); sourceGit(cwd, "add", ".");
      sourceGit(cwd, "commit", "--quiet", "-m", "Owned contract source fixture");
      const revision = sourceGit(cwd, "rev-parse", "HEAD").trim();
      for (const pin of Object.values(manifest.artifacts)) if (pin.repository === repository) pin.revision = revision;
    }
    const changedSource = structuredClone(manifest);
    Object.values(changedSource.artifacts)[0].sha256 = "0".repeat(64);
    assert.throws(() => verifySources(changedSource, sources), /Pinned source mismatch/);
    await writeFile(file, JSON.stringify(manifest));
    const git = (...args) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
        cwd: directory,
        encoding: "utf8",
      });
    git("init", "--quiet");
    git("add", ".");
    git(
      "-c",
      "user.name=Contract Tests",
      "-c",
      "user.email=contracts@example.test",
      "commit",
      "--quiet",
      "-m",
      "test approved baseline",
    );
    const revision = git("rev-parse", "HEAD").trim();
    const check = (...args) =>
      spawnSync(
        process.execPath,
        [
          "scripts/check-api-contracts.mjs",
          "--bundle",
          directory,
          "--release",
          ...args,
        ],
        { encoding: "utf8" },
      );
    const missingRevision = check();
    assert.notEqual(missingRevision.status, 0);
    assert.match(missingRevision.stderr, /requires --release-revision/);
    const pinned = (...args) => check("--release-revision", revision, ...args);
    const missingSources = pinned();
    assert.notEqual(missingSources.status, 0);
    assert.match(missingSources.stderr, /requires --sources/);
    const missingBaseline = pinned("--sources", sources);
    assert.notEqual(missingBaseline.status, 0);
    assert.match(missingBaseline.stderr, /requires an explicit --baseline/);
    const missingBaselineRevision = pinned(
      "--sources",
      sources,
      "--baseline",
      directory,
    );
    assert.notEqual(missingBaselineRevision.status, 0);
    assert.match(
      missingBaselineRevision.stderr,
      /requires --baseline-revision/,
    );
    const initialBaseline = pinned(
      "--sources",
      sources,
      "--baseline",
      directory,
      "--baseline-revision",
      revision,
    );
    assert.equal(initialBaseline.status, 0, initialBaseline.stderr);
    await assert.rejects(
      verifyBundleRevision(directory, manifest, "main"),
      /full immutable/,
    );
    await writeFile(
      resolve(directory, "README.md"),
      "Changed lifecycle semantics\n",
    );
    await assert.rejects(
      verifyBundleRevision(directory, manifest, revision),
      /differs from immutable commit/,
    );
    await assert.rejects(readContractBundle(directory), /README hash mismatch/);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("generation is deterministic and rejects edited generated files", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "lash-her-generated-"));
  try {
    const generate = (...args) =>
      spawnSync(
        process.execPath,
        ["scripts/generate-api-contracts.mjs", "--output", directory, ...args],
        { encoding: "utf8" },
      );
    const first = generate();
    assert.equal(first.status, 0, first.stderr);
    const before = await Promise.all(
      ["course", "community", "boundaries"].map((name) =>
        readFile(resolve(directory, `${name}.d.ts`), "utf8"),
      ),
    );
    assert.equal(generate().status, 0);
    const after = await Promise.all(
      ["course", "community", "boundaries"].map((name) =>
        readFile(resolve(directory, `${name}.d.ts`), "utf8"),
      ),
    );
    assert.deepEqual(after, before);
    assert.equal(generate("--check").status, 0);
    await writeFile(
      resolve(directory, "course.d.ts"),
      before[0] + "// drift\n",
    );
    const drift = generate("--check");
    assert.notEqual(drift.status, 0);
    assert.match(drift.stderr, /Generated contract drift: course/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compatibility allows additions and docs, rejects changed wire fields and security", async () => {
  const baseline = JSON.parse(
    await readFile(resolve(contractDirectory, "course-api.json"), "utf8"),
  );
  const candidate = structuredClone(baseline);
  candidate.paths["/v1/new"] = {
    get: { responses: { 200: { description: "new" } } },
  };
  candidate.paths["/v1/courses"].get.description = "New documentation";
  assert.doesNotThrow(() => assertCompatible(baseline, candidate));
  for (const mutate of [
    (d) => {
      delete d.paths["/v1/courses"];
    },
    (d) => {
      d.paths["/v1/courses"].get.responses[200].content[
        "application/json"
      ].schema.properties.courses.items.properties.description = {
        type: "integer",
      };
    },
    (d) => {
      d.paths["/v1/courses"].get.security = [];
    },
    (d) => {
      d.components.securitySchemes.userBearerAuth.scheme = "basic";
    },
  ]) {
    const changed = structuredClone(baseline);
    mutate(changed);
    assert.throws(() => assertCompatible(baseline, changed), /Removed|Changed/);
  }
});

async function reviewedFixture(run) {
  const temporary = await mkdtemp(resolve(tmpdir(), "contract-reviewed-release-"));
  const root = resolve(temporary, "frontend"), baselineDirectory = resolve(root, "contracts/api-integration/v1");
  const candidateDirectory = resolve(root, "contracts/api-integration/p2-candidate"), sources = resolve(temporary, "sources");
  const git = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Contract fixture", "-c", "user.email=contracts@example.invalid", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  const commit = cwd => { git(cwd, "add", "."); git(cwd, "commit", "--quiet", "-m", "Owned reviewed contract fixture"); return git(cwd, "rev-parse", "HEAD"); };
  try {
    await mkdir(baselineDirectory, { recursive: true }); await cp(contractDirectory, baselineDirectory, { recursive: true });
    const manifest = JSON.parse(await readFile(resolve(baselineDirectory, "manifest.json")));
    manifest.status = "released"; manifest.readmeSha256 = sha256(await readFile(resolve(baselineDirectory, "README.md")));
    await writeFile(resolve(baselineDirectory, "manifest.json"), JSON.stringify(manifest) + "\n");
    git(root, "init", "--quiet"); const baselineRevision = commit(root);
    await cp(baselineDirectory, candidateDirectory, { recursive: true });
    const course = JSON.parse(await readFile(resolve(candidateDirectory, "course-api.json")));
    course.paths["/v1/courses"].get.responses[200].content["application/json"].schema.properties.courses.items.properties.reviewedField = { type: "string" };
    course.paths["/v1/reviewed-addition"] = { get: { responses: { 200: { description: "Additive response" } } } };
    await writeFile(resolve(candidateDirectory, "course-api.json"), JSON.stringify(course) + "\n");
    const boundary = JSON.parse(await readFile(resolve(candidateDirectory, "boundary-contracts.json")));
    boundary.info.title += " reviewed title";
    await writeFile(resolve(candidateDirectory, "boundary-contracts.json"), JSON.stringify(boundary) + "\n");
    const nextManifest = JSON.parse(await readFile(resolve(candidateDirectory, "manifest.json")));
    nextManifest.artifacts.course.sha256 = sha256(await readFile(resolve(candidateDirectory, "course-api.json")));
    nextManifest.boundarySha256 = sha256(await readFile(resolve(candidateDirectory, "boundary-contracts.json")));
    for (const pin of Object.values(nextManifest.artifacts)) {
      const target = resolve(sources, pin.repository, pin.sourcePath); await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve(candidateDirectory, pin.file), target);
    }
    for (const name of new Set(Object.values(nextManifest.artifacts).map(pin => pin.repository))) {
      const source = resolve(sources, name); git(source, "init", "--quiet"); const revision = commit(source);
      for (const pin of Object.values(nextManifest.artifacts)) if (pin.repository === name) pin.revision = revision;
    }
    await writeFile(resolve(candidateDirectory, "manifest.json"), JSON.stringify(nextManifest) + "\n");
    const baseline = readReviewBundleAtRevision(root, baselineRevision), candidate = readReviewBundle(candidateDirectory);
    const review = buildCompatibilityReview(baseline, candidate, baselineRevision);
    for (const change of review.changes.filter(item => item.change !== "added")) Object.assign(change,
      { requirementIds: ["P2-05"], reason: "The coordinated catalog consumer and receiver use the reviewed P2 shape." });
    Object.assign(review.versionedDocuments.boundaries, { requirementIds: ["P2-01"], reason: "Only the historical candidate title changes; identity and lifecycle contracts retain their published semantics." });
    const reviewPath = resolve(candidateDirectory, "compatibility-review.json");
    await writeFile(reviewPath, JSON.stringify(review) + "\n"); const revision = commit(root);
    const options = { reviewPath, reviewRevision: revision, candidateDirectory, candidateRevision: revision, baselineDirectory, baselineRevision };
    const cli = (...extra) => spawnSync(process.execPath, ["scripts/check-api-contracts.mjs", "--bundle", candidateDirectory, "--release",
      "--release-revision", revision, "--sources", sources, "--baseline", baselineDirectory, "--baseline-revision", baselineRevision, ...extra], { encoding: "utf8" });
    await run({ root, baseline, candidate, review, options, revision, baselineRevision, reviewPath, baselineDirectory, candidateDirectory, cli });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

test("an immutable exact-delta review admits only its coordinated changes and title-only boundary delta", async () => reviewedFixture(f => {
  assert.doesNotThrow(() => verifyCompatibilityReview(f.options));
  assert.equal(verifyPublishedPhase2Contracts(f.root, f.revision).manifestSha256, f.candidate.manifestSha256);
  const ordinary = f.cli(); assert.notEqual(ordinary.status, 0); assert.match(ordinary.stderr, /requires compatibility review/u);
  const reviewed = f.cli("--compatibility-review", f.reviewPath, "--review-revision", f.revision);
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.equal(f.review.changes.filter(item => item.change === "changed").length, 1);
  assert.equal(f.review.changes.filter(item => item.change === "added").length, 1);
}));

test("review validation refuses missing, extra, duplicated or mismatched deltas and unknown record fields", async () => reviewedFixture(f => {
  for (const change of [
    review => { review.changes.pop(); }, review => { review.changes.push(structuredClone(review.changes[0])); },
    review => { review.changes.reverse(); }, review => { review.changes[0].afterSha256 = "b".repeat(64); },
    review => { review.changes[0].beforeSha256 = "b".repeat(64); },
    review => { review.changes.find(item => item.change === "changed").requirementIds = []; },
    review => { review.changes.find(item => item.change === "changed").reason = ""; },
    review => { review.approved = true; }, review => { review.changes[0].ignoreFutureChanges = true; },
    review => { review.candidate.revision = "a".repeat(40); },
    review => { review.baseline.manifestSha256 = "b".repeat(64); }, review => { review.candidate.manifestSha256 = "b".repeat(64); },
  ]) {
    const review = structuredClone(f.review); change(review);
    assert.throws(() => validateCompatibilityReview(review, f.baseline, f.candidate, f.baselineRevision));
  }
}));

test("unlisted operations, components and global security cannot hide behind a review", async () => reviewedFixture(f => {
  for (const change of [
    candidate => { candidate.documents.course.paths["/v1/unlisted"] = { post: { responses: { 204: { description: "New" } } } }; },
    candidate => { candidate.documents.course.components.schemas ??= {}; candidate.documents.course.components.schemas.Unlisted = { type: "string" }; },
    candidate => { candidate.documents.course.security = []; },
  ]) {
    const candidate = structuredClone(f.candidate); change(candidate);
    assert.throws(() => validateCompatibilityReview(f.review, f.baseline, candidate, f.baselineRevision), /complete exact delta/u);
  }
  const candidate = structuredClone(f.candidate); candidate.documents.course.servers = [{ url: "https://unreviewed.invalid" }];
  assert.throws(() => validateCompatibilityReview(f.review, f.baseline, candidate, f.baselineRevision), /top-level/u);
}));

test("removed operations and changed components require exact individual review entries", async () => reviewedFixture(f => {
  const candidate = structuredClone(f.candidate);
  delete candidate.documents.course.paths["/v1/courses"].get;
  candidate.documents.course.components.securitySchemes.userBearerAuth.scheme = "basic";
  const review = buildCompatibilityReview(f.baseline, candidate, f.baselineRevision);
  for (const change of review.changes.filter(item => item.change !== "added")) Object.assign(change,
    { requirementIds: ["P2-11"], reason: "Owned test fixture for explicit removed and changed definitions." });
  Object.assign(review.versionedDocuments.boundaries, f.review.versionedDocuments.boundaries);
  assert.ok(review.changes.some(item => item.change === "removed" && item.kind === "operation"));
  assert.ok(review.changes.some(item => item.change === "changed" && item.kind === "component"));
  assert.doesNotThrow(() => validateCompatibilityReview(review, f.baseline, candidate, f.baselineRevision));
  review.changes.find(item => item.kind === "component").beforeSha256 = "b".repeat(64);
  assert.throws(() => validateCompatibilityReview(review, f.baseline, candidate, f.baselineRevision));
}));

test("event changes and boundary changes beyond info.title refuse even with recomputed review hashes", async () => reviewedFixture(f => {
  const eventCandidate = structuredClone(f.candidate), eventReview = structuredClone(f.review);
  eventCandidate.hashes.enrollmentEvent = eventReview.versionedDocuments.enrollmentEvent.afterSha256 = "b".repeat(64);
  assert.throws(() => validateCompatibilityReview(eventReview, f.baseline, eventCandidate, f.baselineRevision), /Enrollment event bytes/u);
  const candidate = structuredClone(f.candidate), review = structuredClone(f.review);
  candidate.documents.boundaries["x-unreviewed"] = true;
  candidate.hashes.boundaries = review.versionedDocuments.boundaries.afterSha256 = "b".repeat(64);
  assert.throws(() => validateCompatibilityReview(review, f.baseline, candidate, f.baselineRevision), /Only the explicitly reviewed boundary/u);
}));

test("wrong candidate, baseline or review revisions and mutable review bytes fail immutable verification", async () => reviewedFixture(async f => {
  for (const change of [
    { candidateRevision: f.baselineRevision }, { baselineRevision: f.revision }, { reviewRevision: f.baselineRevision },
    { candidateRevision: "main" }, { reviewRevision: "main" },
  ]) assert.throws(() => verifyCompatibilityReview({ ...f.options, ...change }));
  const bytes = await readFile(f.reviewPath); await writeFile(f.reviewPath, Buffer.concat([bytes, Buffer.from(" ")]));
  assert.throws(() => verifyCompatibilityReview(f.options), /Review differs from immutable/u);
}));

test("today's counterfeit released-v1 directory cannot replace the archived baseline commit", async () => reviewedFixture(async f => {
  const file = resolve(f.baselineDirectory, "manifest.json"), manifest = JSON.parse(await readFile(file));
  manifest.frontendBaseRevision = "f".repeat(40); manifest.status = "released";
  await writeFile(file, JSON.stringify(manifest) + "\n");
  assert.throws(() => verifyCompatibilityReview(f.options), /differs from the archived released bundle/u);
}));

test("review flags cannot bypass ordinary release prerequisites", () => {
  for (const args of [["--compatibility-review", "review.json"], ["--review-revision", "a".repeat(40)],
    ["--release", "--compatibility-review", "review.json"]]) {
    const run = spawnSync(process.execPath, ["scripts/check-api-contracts.mjs", ...args], { encoding: "utf8" });
    assert.notEqual(run.status, 0); assert.match(run.stderr, /Compatibility review requires/u);
  }
});
