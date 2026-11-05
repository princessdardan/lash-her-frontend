import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { parse } from "yaml";
import { ownedIdentityTarget } from "./harness/owned-frontend-identity-admission.mjs";
import { assertOwnedIdentityReceipt, REQUIRED_IDENTITY_ENTRY_CHECKS, runOwnedIdentityChild } from "./harness/owned-frontend-identity-receipt.mjs";

const owned = { FRONTEND_IDENTITY_OWNED_TEST: "true", OWNED_RECONCILIATION_PORT: "35432",
  OWNED_RECONCILIATION_PASSWORD: "owned-11111111-1111-4111-8111-111111111111", OWNED_RECONCILIATION_MAJOR: "16", NODE_EXTRA_CA_CERTS: "/tmp/owned-ca.crt" };
const frozen = JSON.parse(readFileSync(new URL("../../docs/api-integration/baselines/2026-11-05-p2-00-identity-admission-qualified/postgres16.json", import.meta.url), "utf8")).identity;
const proof = (major = 16) => ({ ...structuredClone(frozen), postgresMajor: major, executedChecks: frozen.checks.length, skipped: 0 });
const expected = major => ({ major, sourceManifestSha256: frozen.applicationSourceManifestSha256 });

test("identity entry qualification accepts explicit PostgreSQL 16/18 loopback bindings and ignores caller database URLs", () => {
  for (const major of [16, 18]) {
    const target = ownedIdentityTarget({ ...owned, OWNED_RECONCILIATION_MAJOR: String(major),
      DATABASE_URL: "postgresql://ignored@external.invalid/production", TEST_DATABASE_URL: "postgresql://also-ignored@external.invalid/production" });
    assert.equal(target.host, "127.0.0.1"); assert.equal(target.database, "frontend_admission_owned");
    assert.equal(target.user, "frontend_admission_protocol"); assert.equal(target.serverMajor, major);
  }
  for (const mutation of [{ FRONTEND_IDENTITY_OWNED_TEST: undefined }, { OWNED_RECONCILIATION_PORT: "0" },
    { OWNED_RECONCILIATION_PORT: "65536" }, { OWNED_RECONCILIATION_MAJOR: "17" }, { OWNED_RECONCILIATION_MAJOR: "18.1" },
    { OWNED_RECONCILIATION_MAJOR: "16.0" },
    { OWNED_RECONCILIATION_PASSWORD: "unowned" }, { NODE_EXTRA_CA_CERTS: "relative-ca.crt" }])
    assert.throws(() => ownedIdentityTarget({ ...owned, ...mutation }));
});

test("identity child refuses missing ownership before application imports or any database connection", () => {
  const result = spawnSync(process.execPath, ["ops/platform/harness/owned-frontend-identity-admission.mjs"], {
    encoding: "utf8", env: { PATH: process.env.PATH, DATABASE_URL: "postgresql://must-not-connect@external.invalid/production" },
  });
  assert.ifError(result.error); assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).phase, "configuration");
  assert.doesNotMatch(result.stderr, /getaddrinfo|ECONNREFUSED|external\.invalid/u);
});

test("owned CI identity runner invokes the actual child once with the parent PostgreSQL major", () => {
  for (const major of [16, 18]) {
    let calls = 0;
    const result = runOwnedIdentityChild((module, environment, status) => {
      calls++;
      assert.equal(module, "ops/platform/harness/owned-frontend-identity-admission.mjs");
      assert.equal(status, "FRONTEND_IDENTITY_OWNED_PASS");
      assert.deepEqual(environment, { FRONTEND_IDENTITY_OWNED_TEST: "true", OWNED_RECONCILIATION_PORT: owned.OWNED_RECONCILIATION_PORT,
        OWNED_RECONCILIATION_PASSWORD: owned.OWNED_RECONCILIATION_PASSWORD, OWNED_RECONCILIATION_MAJOR: String(major) });
      return proof(major);
    }, { port: Number(owned.OWNED_RECONCILIATION_PORT), password: owned.OWNED_RECONCILIATION_PASSWORD, ...expected(major) });
    assert.equal(calls, 1); assert.equal(result.checks.length, 43); assert.equal(result.skipped, 0);
  }
});

test("owned CI rejects absent, empty, partial, duplicate, skipped and finding-bearing identity receipts", () => {
  for (const mutate of [
    () => undefined,
    result => ({ ...result, checks: [], executedChecks: 0, reconciliationEvidenceSha256: [] }),
    result => ({ ...result, checks: result.checks.slice(1), executedChecks: 42, reconciliationEvidenceSha256: result.reconciliationEvidenceSha256.slice(1) }),
    result => ({ ...result, checks: result.checks.map((name, index) => index ? name : result.checks[1]) }),
    result => ({ ...result, checks: result.checks.map((name, index) => index ? name : "unqualified-replacement") }),
    result => ({ ...result, skipped: 1 }),
    result => ({ ...result, executedChecks: 0 }),
    result => ({ ...result, findings: [{ code: "MISSING_RECEIPT" }] }),
    result => ({ ...result, status: "FRONTEND_IDENTITY_OWNED_FINDINGS" }),
    result => ({ ...result, reconciliationEvidenceSha256: [] }),
  ]) assert.throws(() => assertOwnedIdentityReceipt(mutate(proof()), expected(16)));
  assert.equal(REQUIRED_IDENTITY_ENTRY_CHECKS.length, 43);
});

test("owned CI rejects a wrong server major, candidate source or substituted authentication/effect boundary", () => {
  assert.throws(() => assertOwnedIdentityReceipt(proof(16), expected(18)));
  assert.throws(() => assertOwnedIdentityReceipt(proof(18), { major: 18, sourceManifestSha256: "a".repeat(64) }));
  for (const [key, value] of Object.entries({ actualAuthJs: false, actualAuthRouteExport: false, actualAccountRouteExports: false,
    actualAdminLifecycleRouteExport: false, actualLifecycleCronExport: false, verifiedPostgresTls: false,
    realBusinessDatabase: false, providersIntercepted: false, providerTouched: true, migrationAuthorized: true }))
    assert.throws(() => assertOwnedIdentityReceipt({ ...proof(), [key]: value }, expected(16)), key);
});

test("the migration parent executes the mandatory identity child after the 33 existing DB regressions and returns its receipt", () => {
  const source = ts.createSourceFile("parent.mjs", readFileSync(new URL("./test-frontend-migration-local.mjs", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const declarations = new Map(); let result;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declarations.set(node.name.text, node);
      if (node.name.text === "result") result = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const identity = declarations.get("identityRoutes");
  assert.ok(identity && ts.isCallExpression(identity.initializer));
  assert.equal(identity.initializer.expression.getText(source), "runOwnedIdentityChild");
  assert.equal(identity.initializer.arguments[0].getText(source), "runOwnedChild");
  assert.ok(declarations.get("customerIdentityDatabase").pos < identity.pos);
  assert.ok(declarations.get("customerLifecycleDatabase").pos < identity.pos);
  assert.ok(ts.isObjectLiteralExpression(result));
  assert.ok(result.properties.some(property => ts.isShorthandPropertyAssignment(property) && property.name.text === "identityRoutes"));
});

test("required PostgreSQL 18 CI invokes the migration parent containing the identity qualification", () => {
  const workflow = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const job = workflow.jobs["frontend-operator-migrations"];
  assert.ok(job);
  assert.ok(job.steps.some(step => step.run?.includes("lash-her-frontend-migration:postgres18-test") && step.run.includes("docker run")));
  const dockerfile = readFileSync(new URL("./Dockerfile.frontend-migration-test", import.meta.url), "utf8");
  assert.match(dockerfile, /^ENV FRONTEND_MIGRATION_POSTGRES18_LOCAL_TEST=true$/mu);
  const command = JSON.parse(/^CMD (\[.*\])$/mu.exec(dockerfile)?.[1] ?? "null");
  assert.deepEqual(command, ["node", "ops/platform/test-frontend-migration-local.mjs"]);
});
