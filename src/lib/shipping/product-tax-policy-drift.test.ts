import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProductTaxPolicyApprovalInTransaction,
  CheckoutNotReadyError,
} from "./readiness";
import { configuredTaxPolicyApproval } from "./configured-quote-context";

/**
 * Tax-policy VERSION drift between quote and commit must NOT reject a sale
 * (owner directive, mirroring the PR #32 shipping-policy decoupling): the order
 * is charged at the current tax rate regardless. The substantive integrity gate
 * — a complete, approved tax policy in force when the snapshot was issued — is
 * still enforced via the coverage check.
 */

test("stale tax-policy version does not block commit when coverage is complete", async () => {
  const stale = {
    ...configuredTaxPolicyApproval(),
    version: "product-tax-policy-STALE-0000",
  };
  await assert.doesNotReject(
    assertProductTaxPolicyApprovalInTransaction(undefined as never, stale),
  );
});

test("incomplete tax coverage still blocks commit", async () => {
  const base = configuredTaxPolicyApproval();
  const incomplete = {
    ...base,
    coverage: { ...base.coverage, usOrders: false },
  };
  await assert.rejects(
    assertProductTaxPolicyApprovalInTransaction(undefined as never, incomplete),
    (error: unknown) =>
      error instanceof CheckoutNotReadyError &&
      error.blockers.includes("product_tax_policy_not_approved"),
  );
});
