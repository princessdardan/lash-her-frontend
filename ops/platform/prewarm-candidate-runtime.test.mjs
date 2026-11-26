import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runtimeFailure } from "../gateway/runtime/verify.mjs";
import { prewarmRuntimeReferences } from "./prewarm-candidate-runtime.mjs";

function fixture(t, kind) {
  const root = mkdtempSync(join(tmpdir(), "runtime-prewarm-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = join(root, "cache"), source = join(root, "source");
  const runtime = join(source, kind === "api" ? "ops/runtime" : "ops/gateway/runtime");
  mkdirSync(runtime, { recursive: true });
  mkdirSync(cache);
  const file = join(runtime, "build-node.sh");
  writeFileSync(file, "source\n", { mode: 0o644 });
  chmodSync(file, 0o644);
  writeFileSync(join(cache, "index.json"), "{}\n");
  const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "-c", "commit.gpgsign=false", "commit", "-qm", "source");
  const sourceCommit = git("rev-parse", "HEAD").trim();
  const calls = [];
  const execute = (command, args, options) => {
    if (command === "git") return execFileSync(command, args, options);
    calls.push([command, args]);
  };
  return { options: { kind, cache, source, sourceCommit, execute }, file, calls };
}

for (const kind of ["gateway", "migration", "api"]) {
  test(`${kind} prewarms both exact references, importing only its candidate cache`, t => {
    const { options, calls } = fixture(t, kind);
    const { cache, source, sourceCommit } = options;
    prewarmRuntimeReferences(options);
    assert.deepEqual(calls, ["node-reference", "zlib-build"].map(target => ["docker", [
      "buildx", "build", "--platform", "linux/amd64", "--target", target,
      ...(kind === "migration" ? ["-f", join(source, "ops/platform/Dockerfile.frontend-migration"),
        "--build-arg", `FRONTEND_SOURCE_COMMIT=${sourceCommit}`] : []),
      "--output", "type=cacheonly", "--cache-from", `type=local,src=${cache}`,
      kind === "gateway" ? join(source, "ops/gateway") : source,
    ]]));
  });
}

test("prewarm refuses a missing cache, wrong source, or same-byte mode drift before Docker runs", t => {
  const { options, calls, file } = fixture(t, "gateway");
  assert.throws(() => prewarmRuntimeReferences({ ...options, cache: join(options.cache, "missing") }), /MISSING_REFERENCE_BUILD_CACHE/u);
  assert.throws(() => prewarmRuntimeReferences({ ...options, sourceCommit: "b".repeat(40) }), /RUNTIME_REFERENCE_SOURCE_MISMATCH/u);
  chmodSync(file, 0o600);
  assert.throws(() => prewarmRuntimeReferences(options), /RUNTIME_REFERENCE_SOURCE_MODE_MISMATCH/u);
  assert.deepEqual(calls, []);
});

test("public verifier reports matching-field digest pairs without printing arbitrary error contents", () => {
  const candidate = "a".repeat(64), reference = "b".repeat(64);
  assert.deepEqual(runtimeFailure({ message: "NODE_REFERENCE_RECEIPT_MISMATCH", actual: { nodeSha256: candidate }, expected: { nodeSha256: reference } }),
    { reason: "NODE_REFERENCE_RECEIPT_MISMATCH", field: "nodeSha256", candidate, reference });
  assert.deepEqual(runtimeFailure(new Error("synthetic-private-diagnostic")), { reason: "RUNTIME_EVIDENCE_OR_SCAN_REFUSED" });
});
