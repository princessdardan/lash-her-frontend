import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { safeOwnedBootstrapFailure } from "./harness/owned-frontend-probe-diagnostics.mjs";

test("bootstrap failure diagnostics identify only fixed source dependencies and phases", () => {
  const error = Object.assign(new Error("Cannot find module '../../../ops/gateway/routes.json'; private-value"), {
    code: "MODULE_NOT_FOUND", stack: "private-stack", query: "private-query", password: "private-password",
  });
  assert.deepEqual(safeOwnedBootstrapFailure("configuration-import-protected-route", error), {
    status: "FRONTEND_BOOTSTRAP_PROBE_OWNED_FAILED", phase: "configuration-import-protected-route",
    failureCode: "MODULE_RESOLUTION_FAILED", dependency: "ops/gateway/routes.json", providerTouched: false,
  });
  assert.equal(JSON.stringify(safeOwnedBootstrapFailure("private-phase", error)).includes("private-"), false);
});

test("unknown dependencies and arbitrary exception codes cannot become receipt fields", () => {
  const unknown = safeOwnedBootstrapFailure("configuration-import-protected-route",
    Object.assign(new Error("private-url/private-module"), { code: "ERR_MODULE_NOT_FOUND" }));
  assert.equal(unknown.failureCode, "MODULE_RESOLUTION_FAILED"); assert.equal("dependency" in unknown, false);
  for (const error of [undefined, null, "private-value", { name: "private-name", code: "private-code", message: "private-message" }]) {
    assert.deepEqual(safeOwnedBootstrapFailure("configuration", error), {
      status: "FRONTEND_BOOTSTRAP_PROBE_OWNED_FAILED", phase: "configuration", failureCode: "UNCLASSIFIED_FIXTURE_FAILURE", providerTouched: false,
    });
  }
});

test("owned database, TLS, fixture file and assertion failures have bounded diagnostic classes", () => {
  for (const [code, expected] of [["28P01", "OWNED_POSTGRES_REFUSED"], ["42P01", "OWNED_POSTGRES_REFUSED"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "OWNED_CONNECTION_FAILED"], ["ECONNREFUSED", "OWNED_CONNECTION_FAILED"],
    ["ENOENT", "FIXTURE_FILE_UNAVAILABLE"], ["ERR_ASSERTION", "FIXTURE_ASSERTION_FAILED"]]) {
    const value = safeOwnedBootstrapFailure("configuration-operator-connect", { code, message: "private-error-body" });
    assert.equal(value.failureCode, expected); assert.equal(JSON.stringify(value).includes("private-"), false);
  }
});

test("actual owned bootstrap child refuses ambient invocation before imports or network and emits only safe diagnostics", () => {
  const child = spawnSync(process.execPath, ["ops/platform/harness/owned-frontend-bootstrap-probe.mjs"], {
    cwd: new URL("../..", import.meta.url), env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(child.error); assert.equal(child.status, 1); assert.equal(child.stdout, "");
  assert.deepEqual(JSON.parse(child.stderr), {
    status: "FRONTEND_BOOTSTRAP_PROBE_OWNED_FAILED", phase: "configuration", failureCode: "FIXTURE_ASSERTION_FAILED", providerTouched: false,
  });
});
