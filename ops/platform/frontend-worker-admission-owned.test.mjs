import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ownedWorkerTarget } from "./harness/owned-frontend-worker-admission.mjs";

const owned = { FRONTEND_WORKER_ADMISSION_OWNED_TEST: "true", OWNED_RECONCILIATION_PORT: "35432",
  OWNED_RECONCILIATION_PASSWORD: "owned-11111111-1111-4111-8111-111111111111", OWNED_RECONCILIATION_MAJOR: "16", NODE_EXTRA_CA_CERTS: "/private/tmp/owned-ca.crt" };

test("worker qualification accepts only explicit owned loopback bindings", () => {
  for (const major of [16, 18]) {
    const target = ownedWorkerTarget({ ...owned, OWNED_RECONCILIATION_MAJOR: String(major),
      DATABASE_URL: "postgresql://not-used@external.invalid/production" });
    assert.equal(target.host, "127.0.0.1"); assert.equal(target.database, "frontend_admission_owned");
    assert.equal(target.user, "frontend_admission_protocol"); assert.equal(target.serverMajor, major);
  }
  for (const mutation of [{ FRONTEND_WORKER_ADMISSION_OWNED_TEST: undefined }, { OWNED_RECONCILIATION_PORT: "0" },
    { OWNED_RECONCILIATION_PORT: "65536" }, { OWNED_RECONCILIATION_MAJOR: "17" },
    { OWNED_RECONCILIATION_PASSWORD: "unowned" }, { NODE_EXTRA_CA_CERTS: "relative-ca.crt" }])
    assert.throws(() => ownedWorkerTarget({ ...owned, ...mutation }));
});

test("invoking worker qualification without owned authorization refuses before app or database work", () => {
  const environment = { ...process.env, DATABASE_URL: "postgresql://should-not-connect@external.invalid/production" };
  delete environment.FRONTEND_WORKER_ADMISSION_OWNED_TEST;
  const result = spawnSync(process.execPath, ["ops/platform/harness/owned-frontend-worker-admission.mjs"], { encoding: "utf8", env: environment });
  assert.ifError(result.error); assert.equal(result.status, 1); assert.equal(result.stdout, "");
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.status, "FRONTEND_WORKER_ADMISSION_OWNED_FAILED"); assert.equal(failure.phase, "configuration");
  assert.doesNotMatch(result.stderr, /getaddrinfo|ECONNREFUSED|external\.invalid/);
});
