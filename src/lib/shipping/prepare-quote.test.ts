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
  lengthCm: 12,
  widthCm: 8,
  heightCm: 3,
  isRigid: true,
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
      acceptsRigid: true,
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

test("U.S. quote snapshots the customs metadata for an approved U.S. SKU", () => {
  const prepared = prepareShippingQuote(base);
  assert.equal(prepared.customsLines[0]?.hsTariffCode, shipping.hsTariffCode);
  assert.equal(
    prepared.customsLines[0]?.countryOfOrigin,
    shipping.countryOfOrigin,
  );
  assert.equal(
    prepared.customsLines[0]?.manufacturerName,
    shipping.manufacturerName,
  );
});

test("U.S. quote rejects a SKU missing required customs metadata", () => {
  assert.throws(
    () =>
      prepareShippingQuote({
        ...base,
        products: [
          {
            ...base.products[0]!,
            shipping: { ...shipping, hsTariffCode: undefined },
          },
        ],
      }),
    (error) =>
      error instanceof ShippingEligibilityError &&
      /missing_us_hts/.test(error.message),
  );
});

test("U.S. quote rejects an over-length customs manufacturer name (carrier cap)", () => {
  assert.throws(
    () =>
      prepareShippingQuote({
        ...base,
        products: [
          {
            ...base.products[0]!,
            shipping: {
              ...shipping,
              // 36 chars — the exact production value that dead-lettered.
              manufacturerName: "Quingdao Elegant Beauty Craft Co LTD",
            },
          },
        ],
      }),
    (error) =>
      error instanceof ShippingEligibilityError &&
      /manufacturer name exceeds the 35-character/i.test(error.message),
  );
});

test("U.S. quote rejects an over-length customs manufacturer city (carrier cap)", () => {
  assert.throws(
    () =>
      prepareShippingQuote({
        ...base,
        products: [
          {
            ...base.products[0]!,
            shipping: { ...shipping, manufacturerCity: "X".repeat(18) },
          },
        ],
      }),
    (error) =>
      error instanceof ShippingEligibilityError &&
      /manufacturer city exceeds the 17-character/i.test(error.message),
  );
});

test("domestic Canada quote does not apply cross-border customs field caps", () => {
  // Domestic CA never transmits customs line items, so an over-length
  // manufacturer name must NOT block the quote — and the full-fidelity customs
  // snapshot is still retained for audit.
  const prepared = prepareShippingQuote({
    items: base.items,
    products: [
      {
        ...base.products[0]!,
        shipping: {
          ...shipping,
          manufacturerName: "Quingdao Elegant Beauty Craft Co LTD",
        },
      },
    ],
    recipient: {
      ...base.recipient,
      city: "Toronto",
      province: "ON",
      postalCode: "M5V 1A1",
      country: "Canada",
      countryCode: "CA",
    },
    profiles: base.profiles,
    usShippingEnabled: true,
    now,
  });
  assert.equal(
    prepared.customsLines[0]?.manufacturerName,
    "Quingdao Elegant Beauty Craft Co LTD",
  );
});
