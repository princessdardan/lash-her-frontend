import assert from "node:assert/strict";
import test from "node:test";

import { evaluateManualCheckoutReadiness } from "./readiness";
import { PRODUCT_MANUAL_CANCELLATION_POLICY } from "./product-shipping-config";

/**
 * Manual product checkout readiness is now config/env-driven (Phase 2): it reads
 * no owner-attested DB records. These tests pin the blocker logic of
 * `evaluateManualCheckoutReadiness` against the source-controlled config.
 *
 * `PRODUCT_MANUAL_CANCELLATION_POLICY` is now committed (finalized cancellation
 * policy), so a fully-valid runtime is `ready` with no blockers; the tests below
 * derive the expected policy version from the config to avoid drift.
 */

const NOW = new Date("2026-08-15T16:00:00.000Z");

function validEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    MANUAL_PRODUCT_CHECKOUT_ENABLED: "true",
    NEXT_PUBLIC_SITE_URL: "https://www.lashher.ca",
    CRON_SECRET: "0123456789abcdefghijklmnopqrstuvwxyz-CRON",
    CHECKOUT_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
    CHECKOUT_PII_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString("base64"),
  };
}

test("a fully-valid runtime with the committed manual policy is ready", () => {
  process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "enforce";
  return evaluateManualCheckoutReadiness({
    catalogMetadataReady: true,
    env: validEnv(),
    now: NOW,
  }).then((result) => {
    assert.equal(result.ready, true);
    assert.deepEqual(result.blockers, []);
    assert.ok(result.policy);
    // The readiness policy mirrors the source-controlled config exactly.
    assert.equal(
      result.policy?.version,
      PRODUCT_MANUAL_CANCELLATION_POLICY?.version,
    );
    assert.ok(result.taxPolicyVersion);
    assert.ok(result.taxPolicyApproval);
  });
});

test("disabled flag and incomplete catalog each add a blocker", () => {
  process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "observe";
  const env = validEnv();
  env.MANUAL_PRODUCT_CHECKOUT_ENABLED = "false";
  return evaluateManualCheckoutReadiness({
    catalogMetadataReady: false,
    env,
    now: NOW,
  }).then((result) => {
    assert.equal(result.ready, false);
    for (const blocker of [
      "manual_checkout_flag_disabled",
      "catalog_metadata_incomplete",
    ]) {
      assert.ok(
        result.blockers.includes(blocker),
        `expected blocker ${blocker} in ${result.blockers.join(",")}`,
      );
    }
  });
});

test("a dormant shipping-policy worker mode never blocks checkout readiness", async () => {
  // Post-sale policy enforcement is decoupled from the sale: the background
  // worker being in "observe" (or "off") must not add a blocker. A fully-valid
  // runtime stays ready regardless of the worker's enforcement mode.
  for (const mode of ["off", "observe"] as const) {
    process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = mode;
    const result = await evaluateManualCheckoutReadiness({
      catalogMetadataReady: true,
      env: validEnv(),
      now: NOW,
    });
    assert.equal(
      result.blockers.includes("policy_not_enforced"),
      false,
      `mode ${mode} must not add policy_not_enforced`,
    );
    assert.equal(result.ready, true);
  }
});

test("weak secrets and a bad origin are each surfaced", () => {
  process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "enforce";
  const env = validEnv();
  env.NEXT_PUBLIC_SITE_URL = "http://insecure.example.com/path";
  env.CRON_SECRET = "short";
  return evaluateManualCheckoutReadiness({
    catalogMetadataReady: true,
    env,
    now: NOW,
  }).then((result) => {
    assert.equal(result.ready, false);
    for (const blocker of [
      "site_origin_invalid",
      "secret_invalid:CRON_SECRET",
    ]) {
      assert.ok(
        result.blockers.includes(blocker),
        `expected blocker ${blocker} in ${result.blockers.join(",")}`,
      );
    }
  });
});
