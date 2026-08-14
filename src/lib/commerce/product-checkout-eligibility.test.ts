import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getProductCheckoutEligibility,
  resolveCheckoutMode,
} from "./product-checkout-eligibility";

const complete = {
  fulfillmentMode: "physical" as const,
  weightGrams: 35,
  packingUnits: 1,
  customsDescription: "Synthetic eyelash extensions",
  countryOfOrigin: "KR",
};

describe("product checkout eligibility", () => {
  it("requires complete automated metadata", () => {
    assert.deepEqual(getProductCheckoutEligibility(undefined), {
      status: "invalid",
      reason: "missing_fulfillment_mode",
    });
    assert.deepEqual(
      getProductCheckoutEligibility({ ...complete, weightGrams: undefined }),
      {
        status: "invalid",
        reason: "missing_weight",
      },
    );
    assert.equal(getProductCheckoutEligibility(complete).status, "automated");
  });

  it("routes manual and hazardous products away from Chit Chats", () => {
    assert.deepEqual(
      getProductCheckoutEligibility({ fulfillmentMode: "manual" }),
      {
        status: "manual",
        reason: "manual_fulfillment",
      },
    );
    assert.deepEqual(
      getProductCheckoutEligibility({ ...complete, hazardousMaterial: true }),
      {
        status: "manual",
        reason: "hazardous",
      },
    );
  });

  it("fails closed for incomplete U.S. customs metadata", () => {
    assert.deepEqual(getProductCheckoutEligibility(complete, "US"), {
      status: "invalid",
      reason: "us_not_approved",
    });
    assert.deepEqual(
      getProductCheckoutEligibility(
        { ...complete, usShippingApproved: true },
        "US",
      ),
      { status: "invalid", reason: "missing_us_hts" },
    );
  });

  it("rejects mixed manual and automated carts", () => {
    assert.throws(
      () =>
        resolveCheckoutMode([
          getProductCheckoutEligibility(complete),
          getProductCheckoutEligibility({ fulfillmentMode: "manual" }),
        ]),
      /separate carts/i,
    );
  });
});
