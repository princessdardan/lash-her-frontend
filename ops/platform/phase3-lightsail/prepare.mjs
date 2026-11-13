import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const releaseId = "p3-lightsail-synthetic-v1";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const serialize = value => JSON.stringify(value) + "\n";
const service = "lash-her-course-api";
const tag = "0022_legacy_course_imports";
const target = { host: "course-postgres-staging", port: 5432, database: "lash_her_course_staging",
  user: "lash_her_course_staging_migration", serverMajor: 18 };
const [bundle, predecessorSchema, courseSource, output, attestationBundle, ...extra] = process.argv.slice(2);
assert.ok(bundle && predecessorSchema && courseSource && output && attestationBundle && !extra.length, "Usage: node prepare.mjs <attested staging bundle> <retained Course schema> <clean Course checkout> <new private output> <candidate attestation bundle>");
const destination = resolve(output);
assert.ok(isAbsolute(output) && realpathSync(dirname(destination)) === dirname(destination));
for (let parent = dirname(destination); ; parent = dirname(parent)) {
  try { lstatSync(join(parent, ".git")); assert.fail("Keep schema and operator inputs outside Git"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (parent === dirname(parent)) break;
}
assert.match(basename(destination), /^[a-zA-Z0-9_.-]+$/u);

const file = name => readFileSync(join(bundle, name));
const candidateBytes = file("build.candidate.json");
const release = JSON.parse(file("release.candidate.json"));
const candidate = JSON.parse(candidateBytes);
const original = JSON.parse(file("jobs/course.json"));
const schema = file("schema/course.json");
const prior = readFileSync(predecessorSchema);
const predecessor = JSON.parse(prior);
const revision = execFileSync("git", ["-C", courseSource, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["-C", courseSource, "status", "--porcelain"], { encoding: "utf8" }).trim();
assert.equal(dirty, "", "Course checkout must match the candidate commit");
const frontendRevision = candidate.sources?.frontend?.commit;
assert.match(frontendRevision ?? "", /^[a-f0-9]{40}$/u);
const operatorRoot = fileURLToPath(new URL("../../..", import.meta.url));
assert.equal(execFileSync("git", ["-C", operatorRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), frontendRevision,
  "The operator sources must come from the candidate frontend revision");
assert.equal(execFileSync("git", ["-C", operatorRoot, "status", "--porcelain"], { encoding: "utf8" }).trim(), "",
  "Frontend operator checkout must be clean");
execFileSync("gh", ["attestation", "verify", join(bundle, "build.candidate.json"), "--repo", "princessdardan/lash-her-frontend",
  "--signer-workflow", "princessdardan/lash-her-frontend/.github/workflows/platform-artifacts.yml",
  "--signer-digest", frontendRevision, "--source-digest", frontendRevision, "--source-ref", "refs/heads/staging",
  "--deny-self-hosted-runners", "--bundle", attestationBundle], { stdio: ["ignore", "ignore", "inherit"], timeout: 60_000 });
assert.equal(digest(file("build.candidate.json")), digest(candidateBytes), "Candidate changed during verification");
assert.equal(candidate.version, 3);
assert.equal(candidate.environment, "staging");
assert.equal(release.environment, "staging");
assert.equal(release.releaseId, candidate.releaseId);
assert.deepEqual(release.artifacts, candidate.artifacts);
assert.deepEqual(release.sources, candidate.sources);
assert.equal(candidate.integration.state, "passed");
assert.equal(candidate.workload.projectId, "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM");
assert.ok(Object.values(candidate.sources).every(source => source.requiredChecks === "passed"));
assert.equal(candidate.sources.course.commit, revision);
assert.equal(original.sourceCommit, revision);
assert.equal(original.releaseId, candidate.releaseId);
assert.equal(original.environment, "staging");
assert.equal(original.stagingVerification, null);
assert.equal(original.contractPhase, "p2");
assert.equal(original.phase2ContractManifestSha256, candidate.phase2ContractManifestSha256);
assert.deepEqual(original.qualificationTargetProfile, candidate.qualificationTargetProfile);
assert.equal(original.target.service, service);
assert.equal(original.target.environment, "staging");
assert.equal(original.target.allowEmptyBootstrap, false);
assert.deepEqual(original.target.approvedPendingTags, [tag]);
for (const [key, value] of Object.entries(target)) assert.equal(original.target[key], value);
assert.equal(original.runtimeRole, "lash_her_course_staging_runtime");
assert.equal(original.schemaBaselineSha256, digest(schema));
assert.equal(JSON.parse(schema).artifactSha256, original.target.artifactSha256);
assert.equal(predecessor.serverMajor, 18);
assert.equal(predecessor.artifactSha256, "9dda27357f6bf42bd8232f91c027e8d9ec67b7f8b977bd88ea58a3f1960b4749");

const migrationImage = candidate.artifacts.courseMigration.image;
const runtimeImage = candidate.artifacts.courseRuntime.image;
for (const [image, kind, record] of [[migrationImage, "migration", candidate.artifacts.courseMigration], [runtimeImage, "runtime", candidate.artifacts.courseRuntime]]) {
  assert.match(image, new RegExp(`^ghcr\\.io/princessdardan/lash-her-platform-course-${kind}@sha256:[a-f0-9]{64}$`, "u"));
  assert.equal(record.scan, "passed");
}
assert.equal(original.migrationImageDigest, migrationImage.split("@")[1]);
assert.equal(original.runtimeImageDigest, runtimeImage.split("@")[1]);

const fixturePath = fileURLToPath(new URL("./fixture.json", import.meta.url));
const fixture = readFileSync(fixturePath);
const plan = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "scripts/legacy-course-import.ts", "plan", fixturePath],
  { cwd: courseSource, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10_000 }));
assert.equal(plan.courses.length, 1);
assert.equal(plan.courses[0].slug, "phase3-synthetic-legacy-rehearsal");
const job = serialize({ ...original, releaseId });
const review = serialize({ releaseId, environment: "staging", kind: "synthetic-legacy-course-import",
  jobSha256: digest(job), schemaSha256: digest(schema), predecessorSchemaSha256: digest(prior),
  fixtureSha256: digest(fixture), planSha256: plan.planSha256 });
const planRecord = { releaseId, candidateReleaseId: candidate.releaseId, candidateSha256: digest(candidateBytes), reviewSha256: digest(review),
  migrationImage, runtimeImage, target, pendingTags: [tag], fixture: plan.courses[0], trafficAuthorized: false, productionTarget: false };
mkdirSync(destination, { mode: 0o700 });
for (const [name, contents] of [["job.json", job], ["schema.json", schema], ["predecessor-schema.json", prior],
  ["fixture.json", fixture], ["review.json", review], ["plan.json", serialize(planRecord)]]) {
  writeFileSync(join(destination, name), contents, { flag: "wx", mode: 0o600 });
}
console.log(JSON.stringify(planRecord));
