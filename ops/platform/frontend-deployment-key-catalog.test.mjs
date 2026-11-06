import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { FRONTEND_KEY_CATALOG_TEAM, FRONTEND_KEY_CATALOG_PROJECTS, frontendDeploymentKeyCatalogRequest,
  normalizeFrontendDeploymentKeyCatalog } from "./frontend-deployment-key-catalog.mjs";

function fixture() {
  const expected = { version: 1, teamId: FRONTEND_KEY_CATALOG_TEAM, projectId: FRONTEND_KEY_CATALOG_PROJECTS[0], deploymentId: "dpl_ownedFixture",
    sourceCommit: "a".repeat(40), createdAt: 1793754546485, observedAt: "2026-11-06T04:00:00.000Z" };
  const raw = { id: expected.deploymentId, ownerId: expected.teamId, projectId: expected.projectId, createdAt: expected.createdAt,
    project: { id: expected.projectId }, team: { id: expected.teamId }, meta: { githubCommitSha: expected.sourceCommit,
      githubCommitOrg: "princessdardan", githubCommitRepo: "lash-her-frontend", githubRepoId: "1114139712" },
    gitSource: { type: "github", repoId: 1114139712, sha: expected.sourceCommit },
    env: ["runtime_key", "DATABASE_URL", "_ORIGINAL"], build: { env: ["NEXT_PUBLIC_VALUE", "DATABASE_URL"] },
    target: "production", projectSettings: { unrelated: "private-marker-never-copied" } };
  return { expected, raw };
}

test("owner catalogs retain separate exact key names, sorted union and only nonsecret provenance", () => {
  const { expected, raw } = fixture(), result = normalizeFrontendDeploymentKeyCatalog(expected, raw);
  assert.deepEqual(result.runtimeKeyCatalog, ["DATABASE_URL", "_ORIGINAL", "runtime_key"]);
  assert.deepEqual(result.buildKeyCatalog, ["DATABASE_URL", "NEXT_PUBLIC_VALUE"]);
  assert.deepEqual(result.keyCatalog, ["DATABASE_URL", "NEXT_PUBLIC_VALUE", "_ORIGINAL", "runtime_key"]);
  assert.equal(result.keyCatalogSha256, createHash("sha256").update(JSON.stringify(result.keyCatalog)).digest("hex"));
  assert.equal(result.catalogOnly, true); assert.equal(result.originalValuesRecovered, false); assert.equal(result.configuredCapabilitiesVerified, false);
  assert.equal(result.sourceAdmissionFenceVerified, false); assert.equal(result.wholeReleaseAccepted, false);
  assert.equal(JSON.stringify(result).includes("private-marker"), false); assert.ok(Object.isFrozen(result.keyCatalog));
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ?
    Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])])) : value;
  assert.equal(result.provenanceSha256, createHash("sha256").update(JSON.stringify(canonical(result.provenance))).digest("hex"));
  assert.throws(() => result.keyCatalog.push("FORGED"));
});

test("fixed request accepts only the two known projects/team and immutable IDs, with no URL or method override", () => {
  for (const projectId of FRONTEND_KEY_CATALOG_PROJECTS) {
    const { expected } = fixture(); expected.projectId = projectId;
    assert.deepEqual(frontendDeploymentKeyCatalogRequest(expected), { method: "GET", path: `/v13/deployments/dpl_ownedFixture?teamId=${FRONTEND_KEY_CATALOG_TEAM}` });
  }
  for (const [name, value] of [["teamId", "team_foreign"], ["projectId", "prj_foreign"], ["deploymentId", "dpl_id?token=marker"],
    ["url", "https://foreign.example.invalid"], ["method", "DELETE"], ["originalValuesRecovered", true], ["token", "private-marker"]]) {
    const { expected } = fixture(); expected[name] = value; assert.throws(() => frontendDeploymentKeyCatalogRequest(expected), /KEY_CATALOG_REFUSED/u);
  }
});

test("deployment owner/project/creation identities must match the fresh selected surface exactly", () => {
  for (const mutate of [row => { row.id = "dpl_foreign"; }, row => { row.ownerId = "team_foreign"; }, row => { row.projectId = FRONTEND_KEY_CATALOG_PROJECTS[1]; },
    row => { row.project.id = "prj_foreign"; }, row => { row.team.id = "team_foreign"; }, row => { row.createdAt++; }, row => { row.createdAt = String(row.createdAt); }]) {
    const { expected, raw } = fixture(); mutate(raw); assert.throws(() => normalizeFrontendDeploymentKeyCatalog(expected, raw), /KEY_CATALOG_REFUSED/u);
  }
});

test("all present authoritative Git hashes and repository identities agree; missing source is unknown", () => {
  for (const mutate of [row => { row.gitSource.sha = "b".repeat(40); }, row => { row.meta.githubCommitSha = "b".repeat(40); },
    row => { row.meta.githubCommitSha = null; }, row => { row.gitSource.sha = "branch-name"; },
    row => { delete row.meta.githubCommitSha; delete row.gitSource.sha; }, row => { row.gitSource.repoId = 7; },
    row => { row.gitSource.type = "gitlab"; }, row => { row.meta.githubCommitOrg = "foreign"; }, row => { row.meta.githubCommitRepo = "foreign"; }]) {
    const { expected, raw } = fixture(); mutate(raw); assert.throws(() => normalizeFrontendDeploymentKeyCatalog(expected, raw), /KEY_CATALOG_REFUSED/u);
  }
  for (const remove of ["meta", "gitSource"]) {
    const { expected, raw } = fixture(); delete raw[remove]; assert.equal(normalizeFrontendDeploymentKeyCatalog(expected, raw).sourceCommit, expected.sourceCommit);
  }
});

test("both catalogs are mandatory owner arrays; missing/redacted/public variants cannot become empty evidence", () => {
  for (const mutate of [row => { delete row.env; }, row => { delete row.build; }, row => { delete row.build.env; },
    row => { row.env = null; }, row => { row.env = {}; }, row => { row.build.env = "hidden"; }, row => { row.build = []; }]) {
    const { expected, raw } = fixture(); mutate(raw); assert.throws(() => normalizeFrontendDeploymentKeyCatalog(expected, raw), /KEY_CATALOG_REFUSED/u);
  }
  const { expected, raw } = fixture(); raw.env = []; raw.build.env = [];
  const result = normalizeFrontendDeploymentKeyCatalog(expected, raw); assert.deepEqual(result.keyCatalog, []);
  assert.equal(result.catalogOnly, true); assert.equal(result.noCapabilityClosureProduced, true);
});

test("assignments, objects, duplicates, Unicode, whitespace and oversized key names refuse without disclosing input", () => {
  for (const value of [["TOKEN=private-marker"], [{ key: "TOKEN", value: "private-marker" }], ["KEY", "KEY"], ["KEY\n"], [" K"], ["KE Y"], ["ÉNV"], ["1KEY"], [""], ["A".repeat(193)], Array(4097).fill("KEY")]) {
    for (const field of ["env", "build"]) {
      const { expected, raw } = fixture(); if (field === "env") raw.env = value; else raw.build.env = value;
      assert.throws(() => normalizeFrontendDeploymentKeyCatalog(expected, raw), error => error.message === "FRONTEND_DEPLOYMENT_KEY_CATALOG_REFUSED");
    }
  }
  const { expected, raw } = fixture(); raw.env = ["a".repeat(192), "lowercase_valid", "_KEY"];
  assert.equal(normalizeFrontendDeploymentKeyCatalog(expected, raw).runtimeKeyCatalog.length, 3);
});

test("scope timestamps/source and closed input cannot invent missing original identity", () => {
  for (const [name, value] of [["sourceCommit", null], ["sourceCommit", "a".repeat(40) + "\n"], ["createdAt", undefined], ["createdAt", 0],
    ["observedAt", "yesterday"], ["observedAt", "2020-01-01T00:00:00Z"], ["observedAt", "2026-11-31T04:00:00Z"], ["observedAt", "2026-11-06T04:00:00Z\n"]]) {
    const { expected, raw } = fixture(); expected[name] = value; assert.throws(() => normalizeFrontendDeploymentKeyCatalog(expected, raw));
  }
});

test("production target metadata remains a catalog observation with no controls or inferred value recovery", () => {
  const { expected, raw } = fixture(); expected.projectId = FRONTEND_KEY_CATALOG_PROJECTS[1]; raw.projectId = expected.projectId; raw.project.id = expected.projectId;
  const result = normalizeFrontendDeploymentKeyCatalog(expected, raw);
  assert.equal(result.catalogOnly, true); assert.equal(result.sourceAdmissionFenceVerified, false); assert.equal(result.originalValuesRecovered, false);
  assert.equal(Object.hasOwn(result, "environment"), false); assert.equal(Object.hasOwn(result, "target"), false);
});
