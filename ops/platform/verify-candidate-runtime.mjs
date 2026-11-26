import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const definitions = {
  gateway: { repository: "frontend", verifier: "ops/gateway/runtime/verify.mjs", subdirectory: "ops/gateway" },
  "frontend-migration": {
    repository: "frontend", verifier: "ops/gateway/runtime/verify.mjs",
    dockerfile: "ops/platform/Dockerfile.frontend-migration", migration: true,
  },
  "course-runtime": { repository: "course-api", verifier: "ops/runtime/verify.mjs" },
  "course-migration": { repository: "course-api", verifier: "ops/runtime/verify.mjs" },
  "community-runtime": { repository: "community-api", verifier: "ops/runtime/verify.mjs" },
  "community-migration": { repository: "community-api", verifier: "ops/runtime/verify.mjs" },
};

const commit = value => /^(?!0+$)[a-f0-9]{40}$/u.test(value ?? "");
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

export function candidateRuntimeExecutor({ component, cache, sourceCommit, published, root, execute = execFileSync }) {
  assert.ok(Object.hasOwn(definitions, component) && commit(sourceCommit));
  assert.ok(isAbsolute(cache) && !/[,\r\n]/u.test(cache) && existsSync(join(cache, "index.json")), "MISSING_REFERENCE_BUILD_CACHE");
  const definition = definitions[component];
  const context = definition.subdirectory ? join(root, definition.subdirectory) : root;
  const gitContext = `https://github.com/princessdardan/lash-her-${definition.repository}.git#${sourceCommit}`
    + (definition.subdirectory ? `:${definition.subdirectory}` : "");
  const { GIT_AUTH_TOKEN: sourceToken, ...environment } = process.env;
  const built = new Set();
  return (command, args, options) => {
    const buildx = command === "docker" && args[0] === "buildx" && args[1] === "build";
    const dockerBuild = command === "docker" && args[0] === "build";
    if (!buildx && !dockerBuild) return execute(command, args, { ...options, env: environment });

    const inputs = args.slice(buildx ? 2 : 1, -1);
    assert.ok(!inputs.some(arg => /^--(?:cache-from|cache-to|secret)(?:=|$)/u.test(arg)));
    const target = inputs[inputs.indexOf("--target") + 1];
    assert.ok(inputs.includes("--target") && ["node-reference", "zlib-build"].includes(target) && !built.has(target));
    assert.equal(args.at(-1), context);
    assert.equal(inputs[inputs.indexOf("--platform") + 1], "linux/amd64");
    if (dockerBuild) inputs.unshift("--load");

    // The publication solve uses the immutable remote Git context for its provenance.
    // Use that same context and Dockerfile when importing the per-image cache.
    if (published) {
      const index = inputs.indexOf("-f");
      if (index >= 0) inputs.splice(index, 2, "-f", definition.dockerfile ?? "Dockerfile");
      inputs.push("--secret", "id=GIT_AUTH_TOKEN");
    }
    if (definition.migration) inputs.push("--build-arg", `FRONTEND_SOURCE_COMMIT=${sourceCommit}`);
    inputs.push("--cache-from", `type=local,src=${cache}`);
    try {
      const env = published ? { ...environment, GIT_AUTH_TOKEN: sourceToken } : environment;
      const result = execute(command, ["buildx", "build", ...inputs, published ? gitContext : context],
        { ...options, stdio: ["ignore", "pipe", "pipe"], env });
      built.add(target);
      return result;
    } catch {
      throw new Error(target === "node-reference" ? "NODE_REFERENCE_BUILD_FAILED" : "ZLIB_REFERENCE_BUILD_FAILED");
    }
  };
}

export function runtimeFailure(error) {
  if (["NODE_REFERENCE_BUILD_FAILED", "ZLIB_REFERENCE_BUILD_FAILED", "MISSING_REFERENCE_BUILD_CACHE"].includes(error?.message)) {
    return { reason: error.message };
  }
  if (error?.message === "NODE_PACKAGED_EXECUTABLE_MISMATCH" && sha(error.actual) && sha(error.expected)) {
    return { reason: error.message, candidate: error.actual, reference: error.expected };
  }
  for (const [field, reason] of [
    ["nodeSha256", "NODE_REFERENCE_RECEIPT_MISMATCH"],
    ["librarySha256", "ZLIB_REFERENCE_RECEIPT_MISMATCH"],
    ["regressionBinarySha256", "ZLIB_REFERENCE_RECEIPT_MISMATCH"],
    ["packageSha256", "ZLIB_REFERENCE_RECEIPT_MISMATCH"],
  ]) {
    const candidate = error?.actual?.[field], reference = error?.expected?.[field];
    if (sha(candidate) && sha(reference) && candidate !== reference) return { reason, field, candidate, reference };
  }
  if (["NODE_REFERENCE_RECEIPT_MISMATCH", "ZLIB_REFERENCE_RECEIPT_MISMATCH"].includes(error?.message)) {
    return { reason: error.message };
  }
  return { reason: "RUNTIME_EVIDENCE_OR_SCAN_REFUSED" };
}

async function main() {
  const [component, sourceCommit, cache, imageRef, rawScan, output, mode, ...extra] = process.argv.slice(2);
  assert.ok(extra.length === 0 && (mode === "ci" || mode === "publication") && Object.hasOwn(definitions, component));
  const published = mode === "publication";
  const definition = definitions[component];
  assert.ok(published || definition.repository === "frontend");
  const root = published ? resolve("sources", `lash-her-${definition.repository}`) : process.cwd();
  const execute = candidateRuntimeExecutor({ component, cache, sourceCommit, published, root });
  const { verifyRuntimeImage } = await import(pathToFileURL(join(root, definition.verifier)).href);
  verifyRuntimeImage({ imageRef, rawScan, output, migration: definition.migration, execute });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    console.error("PATCHED_RUNTIME_VERIFICATION_FAILED", JSON.stringify(runtimeFailure(error)));
    process.exitCode = 1;
  }
}
