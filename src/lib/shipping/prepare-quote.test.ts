import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareShippingQuote,
  ShippingEligibilityError,
} from "./prepare-quote";

const now = new Date("2026-08-15T12:00:00.000Z");
const contract = {
  importTerms: "DDU" as const,
  disclosure: { version: "ddu-v1", text: "Certified DDU notice." },
  allowedServiceCodes: ["tracked-us"],
  trackedRequired: true as const,
  insuredRequired: true as const,
  tariffMetadataSchema: {
    version: "tariff-v1",
    additionalTariffDetails: "required_when_applicable" as const,
    fields: ["steel", "copper", "aluminum"] as ["steel", "copper", "aluminum"],
  },
  fdaRequirements: {
    version: "fda-v1",
    mode: "required_when_applicable" as const,
  },
  effectiveFrom: "2026-08-01T00:00:00.000Z",
  effectiveUntil: "2027-01-01T00:00:00.000Z",
  evidenceReference: "provider-contract-evidence",
  version: "us-contract-v1",
};
const shipping = {
  fulfillmentMode: "physical" as const,
  weightGrams: 35,
  packingUnits: 1,
  customsDescription: "Synthetic eyelash extensions",
  countryOfOrigin: "KR",
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
    usShippingContractVersion: contract.version,
    tariffMetadataSchemaVersion: contract.tariffMetadataSchema.version,
    fdaRequirementsVersion: contract.fdaRequirements.version,
    evidenceReference: "sku-evidence",
    reviewedAt: "2026-08-02T00:00:00.000Z",
    validUntil: "2026-12-01T00:00:00.000Z",
    additionalTariffApplicability: "not_applicable" as const,
    fdaApplicability: "provider_assessed" as const,
  },
};
const base = {
  items: [{ productId: "product-1", quantity: 1 }],
  products: [
    {
      _id: "product-1",
      title: "Reviewed lashes",
      description: "Reviewed lashes",
      slug: "reviewed-lashes",
      price: 20,
      currency: "CAD" as const,
      isAvailable: true,
      shipping,
    },
  ],
  recipient: {
    name: "Customer",
    email: "customer@example.invalid",
    phone: "+14165550100",
    line1: "100 Test Street",
    city: "Buffalo",
    province: "NY",
    postalCode: "14201",
    country: "United States",
    countryCode: "US" as const,
  },
  profiles: [
    {
      id: "small",
      slug: "small",
      name: "Small",
      rank: 1,
      packageType: "parcel",
      lengthCm: 20,
      widthCm: 15,
      heightCm: 4,
      tareWeightGrams: 40,
      maxWeightGrams: 500,
      capacityUnits: 2,
      enabled: true,
    },
  ],
  usShippingEnabled: true,
  usImportDisclosure: {
    usImportTerms: "DDU" as const,
    usImportDisclosureVersion: contract.disclosure.version,
    usImportDisclosureText: contract.disclosure.text,
  },
  usShippingContract: contract,
  now,
};

test("U.S. quote snapshots the exact SKU certification bound to the current contract", () => {
  const prepared = prepareShippingQuote(base);
  assert.equal(
    prepared.customsLines[0]?.usRegulatoryCertification
      ?.usShippingContractVersion,
    contract.version,
  );
  assert.equal(
    prepared.customsLines[0]?.usRegulatoryCertification
      ?.tariffMetadataSchemaVersion,
    contract.tariffMetadataSchema.version,
  );
});

test("U.S. quote rejects a SKU certification for another contract", () => {
  assert.throws(
    () =>
      prepareShippingQuote({
        ...base,
        products: [
          {
            ...base.products[0]!,
            shipping: {
              ...shipping,
              usRegulatoryCertification: {
                ...shipping.usRegulatoryCertification,
                usShippingContractVersion: "superseded-contract",
              },
            },
          },
        ],
      }),
    (error) =>
      error instanceof ShippingEligibilityError &&
      /contract_mismatch/.test(error.message),
  );
});
