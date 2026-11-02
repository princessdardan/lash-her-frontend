import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertSourceCheckout, verifySourceCheckouts } from "./source-checkout.mjs";
import { ARTIFACT_COMPONENTS } from "./artifact-candidate.mjs";
import { contractManifestHash } from "./release.mjs";
import { SOURCE_REPOSITORY_IDS } from "./source-policy.mjs";
import { fileURLToPath } from "node:url";

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "lash-p1-source-"));
  const git = (...args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "--quiet");
    mkdirSync(join(directory, "src"));
    mkdirSync(join(directory, "tools/api-contract-toolchain"), { recursive: true });
    writeFileSync(join(directory, "tools/api-contract-toolchain/package-lock.json"), "{}\n");
    writeFileSync(join(directory, "src/index.ts"), "export const value = 1;\n");
    writeFileSync(join(directory, ".gitignore"), "node_modules/\n__pycache__/\nsrc/*.generated.ts\n.env*\n");
    git("add", ".");
    git("-c", "user.name=Local fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-gpg-sign", "-m", "fixture");
    run({ directory, git, commit: git("rev-parse", "HEAD") });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function cloneSources(directory, git, commit) {
  const sources = {};
  for (const [name, repository] of [["frontend", "lash-her-frontend"], ["course", "lash-her-course-api"], ["community", "lash-her-community-api"]]) {
    git("clone", "--quiet", "--no-hardlinks", directory, join(directory, repository));
    sources[name] = { repository: `https://github.com/princessdardan/${repository}.git`, commit, requiredChecks: "passed" };
  }
  return sources;
}

test("pinned clean source permits installed dependencies and generated Python cache", () => fixture(({ directory, commit }) => {
  mkdirSync(join(directory, "ops/__pycache__"), { recursive: true });
  writeFileSync(join(directory, "ops/__pycache__/fixture.pyc"), "fixture");
  mkdirSync(join(directory, "tools/api-contract-toolchain/node_modules/fixture"), { recursive: true });
  writeFileSync(join(directory, "tools/api-contract-toolchain/node_modules/fixture/index.js"), "fixture");
  assert.doesNotThrow(() => assertSourceCheckout(directory, commit));
}));

test("tracked changes refuse whether staged or unstaged", () => fixture(({ directory, commit, git }) => {
  writeFileSync(join(directory, "src/index.ts"), "export const value = 2;\n");
  assert.throws(() => assertSourceCheckout(directory, commit));
  git("add", "src/index.ts");
  assert.throws(() => assertSourceCheckout(directory, commit));
  writeFileSync(join(directory, "src/index.ts"), "export const value = 1;\n");
  assert.throws(() => assertSourceCheckout(directory, commit));
}));

test("untracked files and ignored injected source/configuration refuse", () => fixture(({ directory, commit }) => {
  for (const name of ["src/new.ts", "src/injected.generated.ts", ".env.local", "src/node_modules/fixture/index.js", "ops/__pycache__/injected.ts"]) {
    const path = join(directory, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "fixture");
    assert.throws(() => assertSourceCheckout(directory, commit));
    rmSync(path);
  }
  assert.doesNotThrow(() => assertSourceCheckout(directory, commit));
}));

test("wrong revisions and parent repositories cannot substitute for a checkout", () => fixture(({ directory, commit }) => {
  assert.throws(() => assertSourceCheckout(directory, "0".repeat(40)));
  assert.throws(() => assertSourceCheckout(directory, "a".repeat(40)));
  assert.throws(() => assertSourceCheckout(join(directory, "src"), commit));
  assert.throws(() => verifySourceCheckouts(directory, { frontend: { repository: "https://github.com/outsider/fork.git", commit, requiredChecks: "passed" } }));
}));

test("three-repository verification requires every canonical source and successful check pin", () => fixture(({ directory, commit, git }) => {
  const sources = cloneSources(directory, git, commit);
  assert.doesNotThrow(() => verifySourceCheckouts(directory, sources));
  sources.community.requiredChecks = "pending";
  assert.throws(() => verifySourceCheckouts(directory, sources));
}));

test("final CLI requires source/dispatch evidence, qualifies exact fixture images and refuses later dirty source", () => fixture(({ directory, commit, git }) => {
  const sources = cloneSources(directory, git, commit);
  for (const [name, source] of Object.entries(sources)) Object.assign(source, {
    repositoryId: SOURCE_REPOSITORY_IDS[name], branch: "main", branchProtected: false,
    ciRunId: "100", ciAttempt: 1, ciWorkflowSha256: `sha256:${"a".repeat(64)}`,
  });
  const report = JSON.parse(readFileSync(new URL("../../docs/api-integration/baselines/2026-10-29-p1-platform/harness.json", import.meta.url), "utf8"));
  const output = join(directory, "candidate-evidence");
  mkdirSync(output);
  const path = join(output, "release.candidate.json");
  const checkedAt = new Date().toISOString();
  const sourceApproval = { mode: "single-operator-dispatch", operatorGithubUserId: "8996309", runId: "9001", runAttempt: 1, verifiedAt: checkedAt };
  writeFileSync(path, JSON.stringify({ sources, sourceApproval, approval: { state: "pending" },
    artifacts: Object.fromEntries(ARTIFACT_COMPONENTS.map((component) => [component.key, { localImageId: report.images[component.local] }])) }));
  writeFileSync(join(output, "container-harness.json"), JSON.stringify(report));
  const command = [fileURLToPath(new URL("./artifact-candidate.mjs", import.meta.url)), "--harness", output, directory];
  const env = { PATH: process.env.PATH, GITHUB_REPOSITORY: "princessdardan/lash-her-frontend", GITHUB_REPOSITORY_ID: "1114139712",
    GITHUB_REPOSITORY_OWNER_ID: "8996309", GITHUB_ACTOR_ID: "8996309", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_SHA: commit, GITHUB_REF: "refs/heads/main", GITHUB_RUN_ID: "9001", GITHUB_RUN_ATTEMPT: "1" };
  const run = () => execFileSync(process.execPath, command, { env, stdio: "pipe" });
  const unqualified = readFileSync(path, "utf8");
  assert.throws(run);
  assert.equal(readFileSync(path, "utf8"), unqualified);
  writeFileSync(join(output, "source-checks.final.json"), JSON.stringify({ version: 3, checkedAt,
    workflowSha: commit, workflowRef: "refs/heads/main", contractManifestSha256: contractManifestHash(), sources, sourceApproval }));
  run();
  const qualified = readFileSync(path, "utf8");
  assert.equal(JSON.parse(qualified).integration.state, "passed");
  assert.equal(JSON.parse(qualified).approval.state, "pending");
  writeFileSync(join(directory, "lash-her-community-api/src/index.ts"), "export const changed = true;\n");
  assert.throws(run);
  assert.equal(readFileSync(path, "utf8"), qualified);
}));
