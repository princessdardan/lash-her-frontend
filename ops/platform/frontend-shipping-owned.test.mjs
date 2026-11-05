import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ownedShippingTarget } from "./harness/owned-frontend-shipping-admission.mjs";

const owned = { FRONTEND_SHIPPING_OWNED_TEST: "true", OWNED_RECONCILIATION_PORT: "35432",
  OWNED_RECONCILIATION_PASSWORD: "owned-11111111-1111-4111-8111-111111111111", OWNED_RECONCILIATION_MAJOR: "16", NODE_EXTRA_CA_CERTS: "/private/tmp/owned-ca.crt" };

test("shipping qualification accepts only explicit owned loopback bindings", () => {
  for (const major of [16, 18]) {
    const target = ownedShippingTarget({ ...owned, OWNED_RECONCILIATION_MAJOR: String(major), DATABASE_URL: "postgresql://ignored@external.invalid/production" });
    assert.equal(target.host, "127.0.0.1"); assert.equal(target.database, "frontend_admission_owned"); assert.equal(target.serverMajor, major);
  }
  for (const mutation of [{ FRONTEND_SHIPPING_OWNED_TEST: undefined }, { OWNED_RECONCILIATION_PORT: "0" },
    { OWNED_RECONCILIATION_PORT: "65536" }, { OWNED_RECONCILIATION_MAJOR: "17" },
    { OWNED_RECONCILIATION_PASSWORD: "unowned" }, { NODE_EXTRA_CA_CERTS: "relative-ca.crt" }]) assert.throws(() => ownedShippingTarget({ ...owned, ...mutation }));
});

test("standalone shipping harness refuses before application or database imports without ownership", () => {
  const environment = { ...process.env, DATABASE_URL: "postgresql://ignored@external.invalid/production" };
  delete environment.FRONTEND_SHIPPING_OWNED_TEST;
  const result = spawnSync(process.execPath, ["ops/platform/harness/owned-frontend-shipping-admission.mjs"], { env: environment, encoding: "utf8" });
  assert.ifError(result.error); assert.equal(result.status, 1); assert.equal(result.stdout, "");
  const failure = JSON.parse(result.stderr); assert.equal(failure.phase, "configuration");
  assert.doesNotMatch(result.stderr, /getaddrinfo|ECONNREFUSED|external\.invalid/u);
});

test("standalone shipping cluster launcher refuses before any cluster or target activity without ownership", () => {
  const environment = { ...process.env, DATABASE_URL: "postgresql://ignored@external.invalid/production" };
  delete environment.FRONTEND_SHIPPING_LOCAL_TEST;
  const result = spawnSync(process.execPath, ["--import", "tsx", "ops/platform/test-frontend-shipping-local.mjs"], { env: environment, encoding: "utf8" });
  assert.ifError(result.error); assert.equal(result.status, 1); assert.equal(result.stdout, "");
  const failure = JSON.parse(result.stderr); assert.equal(failure.phase, "configuration");
  assert.doesNotMatch(result.stderr, /getaddrinfo|ECONNREFUSED|external\.invalid/u);
});
