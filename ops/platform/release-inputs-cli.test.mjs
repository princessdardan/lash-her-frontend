import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { sourceFixture } from "./release-inputs.fixture.mjs";
import { phase2SourceFixture } from "./phase2-contract-bindings.fixture.mjs";
import { phase2ContractManifestBinding } from "./release.mjs";

// Exercise the real CLI with an isolated provider fixture, no real credentials
// or network access, and no injectable verification bypass in production code.
test("source CLI records exact published P2 approval once and fails without exposing credentials", () => phase2SourceFixture(p2 => {
    const directory = join(p2.directory, "cli-evidence"); mkdirSync(directory);
    const revisions = Object.fromEntries(Object.entries(p2.sources).map(([name, source]) => [name, source.commit]));
    const f = sourceFixture({ revisions, ...phase2ContractManifestBinding(p2.source),
      contractManifestSha256: `sha256:${createHash("sha256").update(readFileSync(join(p2.source, "contracts/api-integration/v1/manifest.json"))).digest("hex")}` });
    const output = join(directory, "source-checks.json");
    const responses = join(directory, "responses.json"), preload = join(directory, "provider.mjs");
    writeFileSync(responses, JSON.stringify([...f.responses]), { mode: 0o600 });
    writeFileSync(preload, `import { readFileSync } from 'node:fs';
const responses = new Map(JSON.parse(readFileSync(${JSON.stringify(responses)}, 'utf8')));
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  if (u.origin !== 'https://api.github.com' || init.redirect !== 'error') throw new Error('No network allowed');
  const value = responses.get(u.pathname + u.search);
  return new Response(JSON.stringify(value ?? {}), { status: value ? 200 : 404 });
};\n`, { mode: 0o600 });
    const environment = { PATH: process.env.PATH,
      GITHUB_REPOSITORY: f.context.repository, GITHUB_REPOSITORY_ID: f.context.repositoryId,
      GITHUB_REPOSITORY_OWNER_ID: f.context.ownerId, GITHUB_ACTOR_ID: f.context.actorId,
      GITHUB_EVENT_NAME: "workflow_dispatch", SOURCE_BRANCH: "main", GITHUB_REF: f.context.workflowRef,
      GITHUB_SHA: f.sha, GITHUB_RUN_ID: f.context.runId, GITHUB_RUN_ATTEMPT: "1",
      FRONTEND_REVISION: revisions.frontend, COURSE_REVISION: revisions.course, COMMUNITY_REVISION: revisions.community,
      SOURCE_READ_TOKEN: "private-fixture-value-do-not-print" };
    const run = (changes = {}, path = output) => spawnSync(process.execPath,
      ["--import", preload, join(p2.source, "ops/platform/release-inputs.mjs"), path],
      { env: { ...environment, ...changes }, encoding: "utf8", timeout: 10_000 });
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /Operator dispatch, exact source revisions and current CI verified/u);
    assert.equal(existsSync(output), true);
    const bytes = readFileSync(output, "utf8"), receipt = JSON.parse(bytes);
    assert.equal(receipt.version, 4);
    assert.equal(receipt.contractPhase, "p2");
    assert.equal(receipt.phase2ContractManifestSha256, f.context.phase2ContractManifestSha256);
    for (const [name, revision] of Object.entries(revisions)) assert.equal(receipt.sources[name].commit, revision);
    assert.equal(new Set(Object.values(revisions)).size, 3);
    assert.equal(receipt.sourceApproval.mode, "single-operator-dispatch");
    assert.equal(receipt.sources.course.branchProtected, false);
    assert.equal(run().status, 1); // No overwrite of evidence.
    assert.equal(readFileSync(output, "utf8"), bytes);
    const refused = (changes = {}) => {
      const refusedPath = join(directory, "refused.json"), result = run(changes, refusedPath);
      assert.equal(result.status, 1);
      assert.equal(existsSync(refusedPath), false);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(environment.SOURCE_READ_TOKEN));
    };
    for (const changes of [{ SOURCE_READ_TOKEN: "" }, { GITHUB_ACTOR_ID: "123" }, { GITHUB_EVENT_NAME: "pull_request" },
      { COURSE_REVISION: revisions.community }, { COMMUNITY_REVISION: revisions.course }]) refused(changes);
    const reviewBytes = readFileSync(p2.reviewPath);
    try {
      writeFileSync(p2.reviewPath, Buffer.concat([reviewBytes, Buffer.from(" ")])); refused();
      rmSync(p2.reviewPath); refused();
    } finally {
      writeFileSync(p2.reviewPath, reviewBytes);
    }
    assert.equal(readFileSync(output, "utf8"), bytes);
}));
