import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiSchemaSource, pullApiSchemas } from "./pull-api-schemas.mjs";

function fixture(t, changes = {}) {
  const root = mkdtempSync(join(tmpdir(), "api-schema-pull-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const candidate = { sources: Object.fromEntries(["course", "community"].map(service => [service, {
    repository: `https://github.com/princessdardan/lash-her-${service}-api.git`, branch: "main",
    requiredChecks: "passed", commit: service === "course" ? "c".repeat(40) : "d".repeat(40), ciRunId: "1234", ciAttempt: 2,
  }])) };
  const destination = join(root, "schemas"), calls = [];
  let current, bytes, labels;
  const run = (program, args) => {
    assert.equal(program, "docker"); calls.push(args);
    if (args[0] === "pull") {
      current = ["course", "community"].find(service => args.at(-1).includes(`lash-her-${service}-api-schema`));
      const selected = apiSchemaSource(candidate, current);
      bytes = Buffer.from(JSON.stringify({ status: "OPERATOR_MIGRATION_OWNED_POSTGRES_PASS", service: `lash-her-${current}-api`,
        providerTouched: false, postgresMajor: 18, schemaBaseline: { schemaVersion: 1, serverMajor: 18, artifactSha256: "b".repeat(64), catalog: {} } }));
      labels = { "org.opencontainers.image.source": "https://github.com/" + selected.repository,
        "org.opencontainers.image.revision": selected.source.commit, "io.lash-her.ci.run-id": "1234", "io.lash-her.ci.run-attempt": "2",
        "io.lash-her.postgres.major": "18", "io.lash-her.operator-schema.sha256": createHash("sha256").update(bytes).digest("hex"),
        ...changes.labels };
      return "";
    }
    if (args[0] === "image") {
      if (args[3] === "{{json .RepoDigests}}") {
        const image = apiSchemaSource(candidate, current).image;
        return JSON.stringify([changes.digest ?? image + "@sha256:" + "e".repeat(64)]);
      }
      return JSON.stringify(labels);
    }
    if (args[0] === "create") return "f".repeat(64);
    if (args[0] === "cp") { writeFileSync(args[2], changes.bytes ?? bytes); return ""; }
    assert.deepEqual(args, ["rm", "--force", "f".repeat(64)]); return "";
  };
  return { candidate, destination, calls, run };
}

test("operator pulls both exact CI baselines by digest into a private new directory", t => {
  const f = fixture(t);
  const result = pullApiSchemas(f.candidate, f.destination, f.run);
  assert.equal(result.length, 2);
  assert.equal(statSync(f.destination).mode & 0o777, 0o700);
  for (const service of ["course", "community"]) {
    const path = join(f.destination, service, "operator-schema-postgres18.json");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(path)).service, `lash-her-${service}-api`);
  }
  assert.equal(f.calls.filter(args => args[0] === "rm").length, 2);
  assert.ok(f.calls.some(args => args[0] === "pull" && args.at(-1).includes("@sha256:")));
});

test("changed role, source, run, attempt or bytes fail and remove the temporary copy", t => {
  for (const changed of [
    { labels: { "org.opencontainers.image.revision": "0".repeat(40) } },
    { labels: { "io.lash-her.ci.run-id": "9999" } },
    { labels: { "io.lash-her.ci.run-attempt": "1" } },
    { digest: "ghcr.io/princessdardan/lash-her-community-api-schema@sha256:" + "e".repeat(64) },
    { bytes: "changed bytes" },
  ]) {
    const f = fixture(t, changed);
    assert.throws(() => pullApiSchemas(f.candidate, f.destination, f.run), /Private API schema retrieval refused/u);
    assert.equal(existsSync(f.destination), false);
    if (f.calls.some(args => args[0] === "create")) assert.equal(f.calls.at(-1)[0], "rm");
  }
});

test("unsuccessful source CI and existing outputs refuse before pulling", t => {
  const f = fixture(t);
  f.candidate.sources.course.requiredChecks = "failed";
  assert.throws(() => pullApiSchemas(f.candidate, f.destination, f.run), /Private API schema retrieval refused/u);
  assert.equal(f.calls.length, 0);
  f.candidate.sources.course.requiredChecks = "passed";
  writeFileSync(f.destination, "keep existing input");
  assert.throws(() => pullApiSchemas(f.candidate, f.destination, f.run), /Private API schema retrieval refused/u);
  assert.equal(readFileSync(f.destination, "utf8"), "keep existing input");
});
