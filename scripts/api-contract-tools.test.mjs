import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  assertCompatible,
  readContractBundle,
  contractDirectory,
} from "./api-contract-tools.mjs";

test("the candidate bundle has immutable revision/hash pins", async () => {
  const { manifest, documents } = await readContractBundle();
  assert.equal(manifest.status, "candidate");
  assert.ok(documents.course.paths["/v1/courses"]);
  const release = spawnSync(
    process.execPath,
    ["scripts/check-api-contracts.mjs", "--release"],
    { encoding: "utf8" },
  );
  assert.notEqual(release.status, 0);
  assert.match(release.stderr, /Candidate contracts cannot certify a release/);
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
  const directory = await mkdtemp(
    resolve(tmpdir(), "lash-her-release-contract-"),
  );
  try {
    await cp(contractDirectory, directory, { recursive: true });
    const file = resolve(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.status = "released"; // Test-only initial approved-baseline fixture.
    // Unit tests own their source repositories; CI has no private sibling clones.
    const sources = resolve(directory, "sources");
    const repositories = new Set(Object.values(manifest.artifacts).map(pin => pin.repository));
    for (const repository of repositories) {
      const root = resolve(sources, repository);
      await mkdir(root, { recursive: true });
      const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Contract fixture", "-c", "user.email=contract@example.test", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      git("init", "--quiet");
      for (const pin of Object.values(manifest.artifacts).filter(pin => pin.repository === repository)) {
        const target = resolve(root, pin.sourcePath);
        await mkdir(dirname(target), { recursive: true });
        await cp(resolve(directory, pin.file), target);
      }
      git("add", ".");
      git("commit", "--quiet", "-m", "Create isolated contract source fixture");
      const revision = git("rev-parse", "HEAD").trim();
      for (const pin of Object.values(manifest.artifacts).filter(pin => pin.repository === repository)) pin.revision = revision;
    }
    await writeFile(file, JSON.stringify(manifest));
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
    const missingSources = check();
    assert.notEqual(missingSources.status, 0);
    assert.match(missingSources.stderr, /requires --sources/);
    const missingBaseline = check("--sources", sources);
    assert.notEqual(missingBaseline.status, 0);
    assert.match(missingBaseline.stderr, /requires an explicit --baseline/);
    const initialBaseline = check("--sources", sources, "--baseline", directory);
    assert.equal(initialBaseline.status, 0, initialBaseline.stderr);
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
