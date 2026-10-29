import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import {
  assertCompatible,
  readContractBundle,
  contractDirectory,
  sha256,
  verifyBundleRevision,
} from "./api-contract-tools.mjs";

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
  const directory = await mkdtemp(
    resolve(tmpdir(), "lash-her-release-contract-"),
  );
  try {
    await cp(contractDirectory, directory, { recursive: true });
    const file = resolve(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.status = "released"; // Test-only initial approved-baseline fixture.
    manifest.readmeSha256 = sha256(
      await readFile(resolve(directory, "README.md")),
    );
    await writeFile(file, JSON.stringify(manifest));
    const git = (...args) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
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
    const sources = resolve(import.meta.dirname, "../..");
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
    await rm(directory, { recursive: true, force: true });
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
