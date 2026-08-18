import assert from "node:assert/strict";
import test from "node:test";

import { evaluateManualCheckoutReadiness } from "./readiness";

/**
 * Manual product checkout readiness is now config/env-driven (Phase 2): it reads
 * no owner-attested DB records. These tests pin the blocker logic of
 * `evaluateManualCheckoutReadiness` against the source-controlled config.
 *
 * `PRODUCT_MANUAL_CANCELLATION_POLICY` is intentionally `null` until the
 * finalized cancellation policy is committed, so readiness can never be `true`
 * here — the strongest assertion available is that a fully-valid runtime leaves
 * `manual_policy_not_configured` as the SOLE blocker.
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

test("a fully-valid runtime leaves only the unconfigured manual policy blocking", () => {
  process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "enforce";
  return evaluateManualCheckoutReadiness({
    catalogMetadataReady: true,
    env: validEnv(),
    now: NOW,
  }).then((result) => {
    assert.equal(result.ready, false);
    assert.deepEqual(result.blockers, ["manual_policy_not_configured"]);
    assert.equal(result.policy, null);
    // Version metadata is always the source-controlled config version.
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
      "manual_policy_not_configured",
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
