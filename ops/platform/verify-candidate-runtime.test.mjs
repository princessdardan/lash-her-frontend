import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { candidateRuntimeExecutor, runtimeFailure } from "./verify-candidate-runtime.mjs";

const sourceCommit = "a".repeat(40);
const root = "/checkout";

function cacheDirectory(t) {
  const cache = mkdtempSync(join(tmpdir(), "candidate-runtime-cache-"));
  writeFileSync(join(cache, "index.json"), "{}\n");
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  return cache;
}

test("CI references import only the candidate cache using the same local context and source", t => {
  const cache = cacheDirectory(t);
  const createExecutor = component => candidateRuntimeExecutor({ component, cache, sourceCommit, root,
    execute: (command, args, options) => ({ command, args, options }) });
  const args = ["buildx", "build", "--platform", "linux/amd64", "--target", "node-reference", "--output", "/reference"];
  const migration = createExecutor("frontend-migration")("docker", [...args, "-f", root + "/ops/platform/Dockerfile.frontend-migration", root]);
  assert.deepEqual(migration.args, [...args, "-f", root + "/ops/platform/Dockerfile.frontend-migration",
    "--build-arg", `FRONTEND_SOURCE_COMMIT=${sourceCommit}`, "--cache-from", `type=local,src=${cache}`, root]);
  assert.deepEqual(migration.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(migration.options.timeout, undefined);
  const gateway = createExecutor("gateway")("docker", [...args, root + "/ops/gateway"]);
  assert.deepEqual(gateway.args, [...args, "--cache-from", `type=local,src=${cache}`, root + "/ops/gateway"]);
});

test("publication references use the same exact immutable Git context without embedding credentials", t => {
  const cache = cacheDirectory(t);
  const existingToken = process.env.GIT_AUTH_TOKEN;
  process.env.GIT_AUTH_TOKEN = "synthetic-source-token";
  t.after(() => {
    if (existingToken === undefined) delete process.env.GIT_AUTH_TOKEN;
    else process.env.GIT_AUTH_TOKEN = existingToken;
  });
  for (const [component, repository, directory] of [
    ["gateway", "frontend", "ops/gateway"],
    ["frontend-migration", "frontend"],
    ["course-runtime", "course-api"],
    ["course-migration", "course-api"],
    ["community-runtime", "community-api"],
    ["community-migration", "community-api"],
  ]) {
    const run = candidateRuntimeExecutor({ component, cache, sourceCommit, root, published: true,
      execute: (command, args, options) => {
        assert.equal(options.env.GIT_AUTH_TOKEN, args[0] === "buildx" ? "synthetic-source-token" : undefined);
        assert.ok(!args.includes("synthetic-source-token"));
        return args;
      } });
    const context = directory ? join(root, directory) : root;
    const reference = run("docker", ["buildx", "build", "--platform", "linux/amd64", "--target", "node-reference", "--output", "/reference", context]);
    const expectedContext = `https://github.com/princessdardan/lash-her-${repository}.git#${sourceCommit}` + (directory ? `:${directory}` : "");
    const index = reference.indexOf("--secret");
    assert.deepEqual(reference.slice(index, index + 2), ["--secret", "id=GIT_AUTH_TOKEN"]);
    assert.deepEqual(reference.slice(-3), ["--cache-from", `type=local,src=${cache}`, expectedContext]);
    const zlib = run("docker", ["build", "--platform", "linux/amd64", "--target", "zlib-build",
      "-f", context + "/Dockerfile", "-t", "reference", context]);
    assert.deepEqual(zlib.slice(0, 3), ["buildx", "build", "--load"]);
    assert.equal(zlib.at(-1), expectedContext);
    assert.equal(zlib[zlib.indexOf("-f") + 1], component === "frontend-migration" ? "ops/platform/Dockerfile.frontend-migration" : "Dockerfile");
    assert.throws(() => run("docker", ["buildx", "build", "--platform", "linux/amd64", "--target", "node-reference", context]));
    assert.deepEqual(run("docker", ["run", "--rm", "--network", "none", "reference"]), ["run", "--rm", "--network", "none", "reference"]);
  }
});

test("missing caches, unrelated builds and mismatched evidence fail without printing arbitrary error contents", t => {
  const cache = cacheDirectory(t);
  assert.throws(() => candidateRuntimeExecutor({ component: "gateway", cache: join(cache, "missing"), sourceCommit, root }),
    /MISSING_REFERENCE_BUILD_CACHE/u);
  const run = candidateRuntimeExecutor({ component: "gateway", cache, sourceCommit, root,
    execute: () => { throw new Error("synthetic-private-diagnostic"); } });
  assert.throws(() => run("docker", ["buildx", "build", "--platform", "linux/amd64", "--target", "unrelated", root + "/ops/gateway"]));
  assert.throws(() => run("docker", ["buildx", "build", "--platform", "linux/amd64", "--target", "node-reference",
    "--cache-from", "type=gha,scope=unreviewed", root + "/ops/gateway"]));
  assert.throws(() => run("docker", ["buildx", "build", "--platform", "linux/amd64", "--target", "node-reference", root + "/ops/gateway"]),
    /^Error: NODE_REFERENCE_BUILD_FAILED$/u);
  const candidate = "a".repeat(64), reference = "b".repeat(64);
  assert.deepEqual(runtimeFailure({ message: "synthetic-private-diagnostic", actual: { nodeSha256: candidate }, expected: { nodeSha256: reference } }),
    { reason: "NODE_REFERENCE_RECEIPT_MISMATCH", field: "nodeSha256", candidate, reference });
  assert.deepEqual(runtimeFailure(new Error("synthetic-private-diagnostic")), { reason: "RUNTIME_EVIDENCE_OR_SCAN_REFUSED" });
});
