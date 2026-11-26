import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function prewarmRuntimeReferences({ kind, source, sourceCommit, cache, execute = execFileSync }) {
  assert.ok(["gateway", "migration", "api"].includes(kind));
  assert.match(sourceCommit, /^(?!0+$)[a-f0-9]{40}$/u);
  assert.ok(isAbsolute(cache) && !/[,\r\n]/u.test(cache) && existsSync(join(cache, "index.json")), "MISSING_REFERENCE_BUILD_CACHE");
  const runtimePath = kind === "api" ? "ops/runtime" : "ops/gateway/runtime";
  const git = (...args) => execute("git", args, { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(git("rev-parse", "HEAD").trim(), sourceCommit, "RUNTIME_REFERENCE_SOURCE_MISMATCH");
  assert.equal(git("status", "--porcelain", "--untracked-files=all", "--", runtimePath), "", "RUNTIME_REFERENCE_SOURCE_CHANGED");
  const files = git("ls-files", "--stage", "-z", "--", runtimePath).split("\0").filter(Boolean);
  assert.ok(files.length > 0, "RUNTIME_REFERENCE_SOURCE_MISSING");
  for (const file of files) {
    const match = /^(100644|100755) [a-f0-9]{40} 0\t(.+)$/u.exec(file);
    assert.ok(match, "RUNTIME_REFERENCE_SOURCE_MODE_MISMATCH");
    const stat = lstatSync(join(source, match[2]));
    assert.ok(stat.isFile() && (stat.mode & 0o777) === parseInt(match[1].slice(-3), 8),
      "RUNTIME_REFERENCE_SOURCE_MODE_MISMATCH");
  }
  const context = kind === "gateway" ? join(source, "ops/gateway") : source;
  const recipe = kind === "migration"
    ? ["-f", join(source, "ops/platform/Dockerfile.frontend-migration"), "--build-arg", `FRONTEND_SOURCE_COMMIT=${sourceCommit}`]
    : [];
  for (const target of ["node-reference", "zlib-build"]) {
    try {
      execute("docker", ["buildx", "build", "--platform", "linux/amd64", "--target", target, ...recipe,
        "--output", "type=cacheonly", "--cache-from", `type=local,src=${cache}`, context],
      { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
    } catch {
      throw new Error(target === "node-reference" ? "NODE_REFERENCE_PREWARM_FAILED" : "ZLIB_REFERENCE_PREWARM_FAILED");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 6);
    assert.match(process.env.BUILDX_BUILDER ?? "", /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u);
    const [kind, source, sourceCommit, cache] = process.argv.slice(2);
    prewarmRuntimeReferences({ kind, source: resolve(source), sourceCommit, cache });
  } catch (error) {
    const reason = /^(?:MISSING_REFERENCE_BUILD_CACHE|RUNTIME_REFERENCE_SOURCE_[A-Z_]+|(?:NODE|ZLIB)_REFERENCE_PREWARM_FAILED)$/u.test(error?.message ?? "")
      ? error.message : "RUNTIME_REFERENCE_PREWARM_REFUSED";
    console.error(reason);
    process.exitCode = 1;
  }
}
