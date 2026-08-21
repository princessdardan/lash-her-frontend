import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getProductCheckoutEligibility,
  resolveCheckoutMode,
} from "./product-checkout-eligibility";

const complete = {
  fulfillmentMode: "physical" as const,
  weightGrams: 35,
  lengthCm: 12,
  widthCm: 8,
  heightCm: 3,
  isRigid: true,
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
    assert.deepEqual(
      getProductCheckoutEligibility({ ...complete, heightCm: undefined }),
      {
        status: "invalid",
        reason: "missing_dimensions",
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

  it("requires current evidence-backed U.S. tariff and FDA applicability", () => {
    const usBase = {
      ...complete,
      usShippingApproved: true,
      hsTariffCode: "6704190000",
      manufacturerName: "Reviewed Manufacturer",
      manufacturerAddress: "123 Factory Road",
      manufacturerCity: "Seoul",
      manufacturerProvinceCode: "SE",
      manufacturerPostalCode: "04524",
      manufacturerCountryCode: "KR",
    };
    assert.deepEqual(getProductCheckoutEligibility(usBase, "US"), {
      status: "invalid",
      reason: "missing_us_regulatory_certification",
    });
    assert.equal(
      getProductCheckoutEligibility(
        {
          ...usBase,
          usRegulatoryCertification: {
            version: "sku-review-v1",
            usShippingContractVersion: "us-contract-v1",
            tariffMetadataSchemaVersion: "tariff-v1",
            fdaRequirementsVersion: "fda-v1",
            evidenceReference: "controlled-evidence-1",
            reviewedAt: "2026-08-01T00:00:00.000Z",
            validUntil: "2099-08-01T00:00:00.000Z",
            additionalTariffApplicability: "not_applicable",
            fdaApplicability: "provider_assessed",
          },
        },
        "US",
      ).status,
      "automated",
    );
    assert.deepEqual(
      getProductCheckoutEligibility(
        {
          ...usBase,
          usRegulatoryCertification: {
            version: "sku-review-v1",
            usShippingContractVersion: "us-contract-v1",
            tariffMetadataSchemaVersion: "tariff-v1",
            fdaRequirementsVersion: "fda-v1",
            evidenceReference: "controlled-evidence-1",
            reviewedAt: "2026-08-01T00:00:00.000Z",
            validUntil: "2099-08-01T00:00:00.000Z",
            additionalTariffApplicability: "required",
            additionalTariffDetails: { steel: 0, copper: 0 },
            fdaApplicability: "not_applicable",
          },
        },
        "US",
      ),
      { status: "invalid", reason: "missing_us_additional_tariff_details" },
    );
  });

  it("binds the exact SKU review to the current certified U.S. contract", () => {
    const metadata = {
      ...complete,
      usShippingApproved: true,
      hsTariffCode: "6704190000",
      manufacturerName: "Reviewed Manufacturer",
      manufacturerAddress: "123 Factory Road",
      manufacturerCity: "Seoul",
      manufacturerProvinceCode: "SE",
      manufacturerPostalCode: "04524",
      manufacturerCountryCode: "KR",
      usRegulatoryCertification: {
        version: "sku-review-v1",
        usShippingContractVersion: "us-contract-v1",
        tariffMetadataSchemaVersion: "tariff-v1",
        fdaRequirementsVersion: "fda-v1",
        evidenceReference: "controlled-evidence-1",
        reviewedAt: "2026-08-02T00:00:00.000Z",
        validUntil: "2026-12-01T00:00:00.000Z",
        additionalTariffApplicability: "not_applicable" as const,
        fdaApplicability: "provider_assessed" as const,
      },
    };
    const context = {
      now: new Date("2026-08-15T00:00:00.000Z"),
      usShippingContract: {
        version: "us-contract-v1",
        effectiveFrom: "2026-08-01T00:00:00.000Z",
        effectiveUntil: "2027-01-01T00:00:00.000Z",
        tariffMetadataSchema: { version: "tariff-v1" },
        fdaRequirements: { version: "fda-v1" },
      },
    };
    assert.equal(
      getProductCheckoutEligibility(metadata, "US", context).status,
      "automated",
    );
    assert.deepEqual(
      getProductCheckoutEligibility(metadata, "US", {
        ...context,
        usShippingContract: {
          ...context.usShippingContract,
          version: "us-contract-v2",
        },
      }),
      { status: "invalid", reason: "us_regulatory_contract_mismatch" },
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
