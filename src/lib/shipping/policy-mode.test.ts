import assert from "node:assert/strict";
import test from "node:test";

import {
  assertShippingPolicyConfigurationMutationAllowed,
  assertShippingPolicyMutationAllowed,
  ShippingPolicyMutationBlockedError,
} from "./policy";

test("business mutations are allowed only in enforce mode", () => {
  const previous = process.env.SHIPPING_POLICY_ENFORCEMENT_MODE;
  try {
    process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "off";
    assert.throws(
      () => assertShippingPolicyMutationAllowed(),
      ShippingPolicyMutationBlockedError,
    );
    process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "observe";
    assert.throws(
      () => assertShippingPolicyMutationAllowed(),
      ShippingPolicyMutationBlockedError,
    );
    process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "enforce";
    assert.doesNotThrow(() => assertShippingPolicyMutationAllowed());
  } finally {
    if (previous === undefined)
      delete process.env.SHIPPING_POLICY_ENFORCEMENT_MODE;
    else process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = previous;
  }
});

test("configuration is read-only in observe mode", () => {
  const previous = process.env.SHIPPING_POLICY_ENFORCEMENT_MODE;
  try {
    process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "observe";
    assert.throws(
      () => assertShippingPolicyConfigurationMutationAllowed(),
      ShippingPolicyMutationBlockedError,
    );
    process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "off";
    assert.doesNotThrow(() =>
      assertShippingPolicyConfigurationMutationAllowed(),
    );
  } finally {
    if (previous === undefined)
      delete process.env.SHIPPING_POLICY_ENFORCEMENT_MODE;
    else process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = previous;
  }
});
