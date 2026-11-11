import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { REQUIRED_SOURCE_JOBS, SOURCE_REPOSITORIES, SOURCE_REPOSITORY_IDS, SOURCE_OPERATOR_ID, isRevision } from "./source-policy.mjs";

export const replacementApiNames = ["course", "community"];
const sourceFile = "src/db/operator-migration.ts";
const allowedFiles = [sourceFile, "tests/operator-migration.test.ts"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = value => typeof value === "string" && /^(?!0+$)[a-f0-9]{64}$/u.test(value);
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype &&
  isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());
const demand = condition => { if (!condition) throw new Error("P2_REPLACEMENT_ROLE_POLICY_SUPPLEMENT_REFUSED"); };

export function requireReplacementRolePolicyReview(review) {
  if (exact(review, ["actionId", "originalDirectory", "originalEvidenceSha256"])) return;
  demand(exact(review, ["actionId", "originalDirectory", "originalEvidenceSha256", "priorRecovery", "rolePolicySupplement"]));
  const prior = review.priorRecovery;
  demand(exact(prior, ["actionId", "evidenceSha256"]) && typeof prior.actionId === "string" &&
    /^[a-z0-9][a-z0-9-]{0,63}$/u.test(prior.actionId) && prior.actionId !== review.actionId &&
    exact(prior.evidenceSha256, ["physicalObservation", "runtimeOutcome", "migrationOutcome", "courseJobOutcome",
      "runtimeContainment", "gatewayStopped"]) && Object.values(prior.evidenceSha256).every(digest) &&
    exact(review.rolePolicySupplement, replacementApiNames));
  for (const name of replacementApiNames) {
    const item = review.rolePolicySupplement[name];
    demand(exact(item, ["baseSourceCommit", "sourceCommit", "sourceSha256", "compiledSha256"]) &&
      isRevision(item.baseSourceCommit) && isRevision(item.sourceCommit) && item.baseSourceCommit !== item.sourceCommit &&
      digest(item.sourceSha256) && digest(item.compiledSha256));
  }
}

export async function verifyReplacementRolePolicySource(api, name, supplement) {
  demand(replacementApiNames.includes(name));
  const repository = SOURCE_REPOSITORIES[name];
  const prefix = "/repos/" + repository;
  const id = SOURCE_REPOSITORY_IDS[name];
  const [metadata, commit, source, runs] = await Promise.all([
    api(prefix),
    api(prefix + "/commits/" + supplement.sourceCommit),
    api(prefix + "/contents/" + sourceFile + "?ref=" + supplement.sourceCommit),
    api(prefix + "/actions/workflows/ci.yml/runs?head_sha=" + supplement.sourceCommit + "&per_page=100"),
  ]);
  demand(metadata.full_name === repository && metadata.private === true &&
    String(metadata.id) === id && String(metadata.owner?.id) === SOURCE_OPERATOR_ID);
  demand(commit.sha === supplement.sourceCommit && commit.parents?.length === 1 &&
    commit.parents[0].sha === supplement.baseSourceCommit && Array.isArray(commit.files) &&
    commit.files.length === allowedFiles.length && allowedFiles.every(file =>
      commit.files.some(change => change.filename === file && change.status === "modified")));
  demand(source.type === "file" && source.path === sourceFile && source.encoding === "base64" &&
    typeof source.content === "string" && Number.isSafeInteger(source.size) && source.size > 0 && source.size <= 65_536);
  const encoded = source.content.replace(/\n/gu, "");
  const bytes = Buffer.from(encoded, "base64");
  demand(bytes.toString("base64") === encoded && bytes.length === source.size && sha(bytes) === supplement.sourceSha256);
  demand(Array.isArray(runs.workflow_runs) && runs.total_count === runs.workflow_runs.length &&
    runs.total_count > 0 && runs.total_count <= 100);
  const run = [...runs.workflow_runs].sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];
  demand(run.head_sha === supplement.sourceCommit && Number.isSafeInteger(run.id) && run.id > 0 &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 && run.path === ".github/workflows/ci.yml" &&
    ["pull_request", "workflow_dispatch", "push"].includes(run.event) && run.status === "completed" &&
    run.conclusion === "success" && run.repository?.full_name === repository &&
    String(run.repository?.id) === id && run.head_repository?.full_name === repository &&
    String(run.head_repository?.id) === id && String(run.actor?.id) === SOURCE_OPERATOR_ID);
  const jobs = await api(prefix + `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  demand(Array.isArray(jobs.jobs) && jobs.jobs.length === jobs.total_count && jobs.total_count <= 100 &&
    REQUIRED_SOURCE_JOBS[name].every(required => jobs.jobs.some(job => job.name === required)) &&
    jobs.jobs.every(job => job.status === "completed" && job.conclusion === "success"));
  return { ...supplement, ciUrl: `https://github.com/${repository}/actions/runs/${run.id}`, ciAttempt: run.run_attempt };
}

export function verifyReplacementRolePolicyBuild(name, sourceDirectory, supplement) {
  demand(replacementApiNames.includes(name) && process.versions.node === "24.18.0" &&
    typeof sourceDirectory === "string" && resolve(sourceDirectory) === sourceDirectory &&
    realpathSync(sourceDirectory) === sourceDirectory && isRevision(supplement.sourceCommit));
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "lash-role-policy-build-"));
  const checkout = join(scratch, "source"), archive = join(scratch, "source.tar");
  // Neither Git nor npm inherits the release launcher’s credential environment.
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: scratch, LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1" };
  const run = (program, args, cwd, timeout = 30_000) => execFileSync(program, args, {
    env, cwd, timeout, maxBuffer: 1_000_000, stdio: ["ignore", "pipe", "pipe"],
  });
  const git = (...args) => run("/usr/bin/git", ["-C", sourceDirectory, ...args], scratch);
  try {
    demand(git("remote", "get-url", "origin").toString().trim() === `https://github.com/${SOURCE_REPOSITORIES[name]}.git`);
    demand(git("rev-parse", "--verify", `${supplement.sourceCommit}^{commit}`).toString().trim() === supplement.sourceCommit);
    git("archive", "--format=tar", "--output=" + archive, supplement.sourceCommit);
    mkdirSync(checkout, { mode: 0o700 });
    run("/usr/bin/tar", ["-xf", archive, "-C", checkout], scratch);
    demand(sha(readFileSync(join(checkout, sourceFile))) === supplement.sourceSha256);
    const npm = resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
    run(process.execPath, [npm, "ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund",
      "--globalconfig=/dev/null", "--registry=https://registry.npmjs.org",
      "--cache=" + join(homedir(), ".npm")], checkout, 120_000);
    const packageInfo = JSON.parse(readFileSync(join(checkout, "package.json")));
    demand(packageInfo.scripts?.["build:migration"] === "tsc -p tsconfig.migration-build.json");
    run(process.execPath, [join(checkout, "node_modules", "typescript", "bin", "tsc"),
      "-p", "tsconfig.migration-build.json"], checkout, 90_000);
    const compiled = readFileSync(join(checkout, "dist-migration", "src", "db", "operator-migration.js"));
    demand(compiled.length > 0 && compiled.length <= 65_536 && sha(compiled) === supplement.compiledSha256);
    return { compiledSha256: sha(compiled), lockfileSha256: sha(readFileSync(join(checkout, "package-lock.json"))),
      nodeVersion: process.versions.node };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
