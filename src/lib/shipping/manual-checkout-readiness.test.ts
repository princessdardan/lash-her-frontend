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

function strongContract(): string {
  return JSON.stringify({
    contract: "helcim_product_payments",
    version: "manual-readiness-unit-v1",
    evidenceReference: "test://manual-readiness/helcim",
    effectiveFrom: new Date(NOW.getTime() - 86_400_000).toISOString(),
    effectiveUntil: new Date(NOW.getTime() + 86_400_000).toISOString(),
    purchaseTransactionTypes: ["purchase"],
    refundTransactionTypes: ["refund"],
    purchaseSuccessfulStatuses: ["approved"],
    refundSuccessfulStatuses: ["approved"],
    avs: {
      fieldNames: ["avsresponse"],
      matchCodes: ["m"],
      mismatchCodes: ["n"],
    },
    cvv: {
      fieldNames: ["cvvresponse"],
      matchCodes: ["m"],
      mismatchCodes: ["n"],
    },
    refundCorrelation: {
      providerRefundIdFields: ["transactionid"],
      originalTransactionIdFields: ["originaltransactionid"],
      merchantReferenceFields: ["merchantreference"],
    },
  });
}

function validEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    MANUAL_PRODUCT_CHECKOUT_ENABLED: "true",
    NEXT_PUBLIC_SITE_URL: "https://www.lashher.ca",
    CRON_SECRET: "0123456789abcdefghijklmnopqrstuvwxyz-CRON",
    CHECKOUT_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
    CHECKOUT_PII_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString("base64"),
    HELCIM_GENERAL_API_TOKEN: "general-api-token-manual-readiness",
    HELCIM_TRANSACTION_API_TOKEN: "transaction-api-token-manual-readiness",
    HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON: strongContract(),
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

test("disabled flag, dormant policy mode, and incomplete catalog each add a blocker", () => {
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
      "policy_not_enforced",
      "catalog_metadata_incomplete",
    ]) {
      assert.ok(
        result.blockers.includes(blocker),
        `expected blocker ${blocker} in ${result.blockers.join(",")}`,
      );
    }
  });
});

test("weak secrets, bad origin, and a missing Helcim contract are each surfaced", () => {
  process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "enforce";
  const env = validEnv();
  env.NEXT_PUBLIC_SITE_URL = "http://insecure.example.com/path";
  env.CRON_SECRET = "short";
  delete env.HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON;
  return evaluateManualCheckoutReadiness({
    catalogMetadataReady: true,
    env,
    now: NOW,
  }).then((result) => {
    assert.equal(result.ready, false);
    for (const blocker of [
      "site_origin_invalid",
      "secret_invalid:CRON_SECRET",
      "helcim_contract_not_configured_or_expired",
    ]) {
      assert.ok(
        result.blockers.includes(blocker),
        `expected blocker ${blocker} in ${result.blockers.join(",")}`,
      );
    }
  });
});

test("an expired Helcim contract is treated as not configured", () => {
  process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "enforce";
  const env = validEnv();
  return evaluateManualCheckoutReadiness({
    catalogMetadataReady: true,
    env,
    // now is after the contract's effectiveUntil.
    now: new Date(NOW.getTime() + 200_000_000),
  }).then((result) => {
    assert.ok(
      result.blockers.includes("helcim_contract_not_configured_or_expired"),
      result.blockers.join(","),
    );
  });
});
