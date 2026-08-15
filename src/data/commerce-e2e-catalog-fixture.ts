import type { TProduct } from "@/types";

export const COMMERCE_E2E_US_CONTRACT_VERSION = "e2e-us-contract-v1";
export const COMMERCE_E2E_TARIFF_SCHEMA_VERSION = "e2e-tariff-v1";
export const COMMERCE_E2E_FDA_REQUIREMENTS_VERSION = "e2e-fda-v1";

const PRODUCTS: readonly TProduct[] = [
  {
    _id: "commerce-e2e-automated-ca",
    title: "E2E Canada Lash Kit",
    description: "Deterministic automated Canada checkout fixture.",
    shortDescription: "Automated Canada checkout fixture",
    slug: "commerce-e2e-automated-ca",
    price: 24,
    sku: "E2E-CA-KIT",
    currency: "CAD",
    variantModel: "concrete",
    isAvailable: true,
    availabilityLabel: "In stock",
    shipping: {
      fulfillmentMode: "physical",
      weightGrams: 120,
      packingUnits: 1,
      minimumPackageTier: "small",
      customsDescription: "Synthetic eyelash aftercare kit",
      countryOfOrigin: "CA",
      hazardousMaterial: false,
    },
    displayOrder: 1,
  },
  {
    _id: "commerce-e2e-automated-us",
    title: "E2E U.S. DDU Lash Kit",
    description: "Deterministic automated U.S. DDU checkout fixture.",
    shortDescription: "Automated U.S. DDU checkout fixture",
    slug: "commerce-e2e-automated-us",
    price: 28,
    sku: "E2E-US-KIT",
    currency: "CAD",
    variantModel: "concrete",
    isAvailable: true,
    availabilityLabel: "In stock",
    shipping: {
      fulfillmentMode: "physical",
      weightGrams: 140,
      packingUnits: 1,
      minimumPackageTier: "small",
      customsDescription: "Synthetic eyelash application kit",
      countryOfOrigin: "CA",
      hazardousMaterial: false,
      usShippingApproved: true,
      hsTariffCode: "6704190000",
      manufacturerName: "Lash Her Studio",
      manufacturerAddress: "646 Oakwood Avenue",
      manufacturerCity: "Toronto",
      manufacturerProvinceCode: "ON",
      manufacturerPostalCode: "M6E 2Y4",
      manufacturerCountryCode: "CA",
      usRegulatoryCertification: {
        version: "e2e-us-sku-cert-v1",
        usShippingContractVersion: COMMERCE_E2E_US_CONTRACT_VERSION,
        tariffMetadataSchemaVersion: COMMERCE_E2E_TARIFF_SCHEMA_VERSION,
        fdaRequirementsVersion: COMMERCE_E2E_FDA_REQUIREMENTS_VERSION,
        evidenceReference: "e2e://catalog/us-sku-cert-v1",
        reviewedAt: "2026-08-01T00:00:00.000Z",
        validUntil: "2027-08-01T00:00:00.000Z",
        additionalTariffApplicability: "not_applicable",
        fdaApplicability: "not_applicable",
      },
    },
    displayOrder: 2,
  },
  {
    _id: "commerce-e2e-manual",
    title: "E2E Manual Pickup Product",
    description: "Deterministic manual pickup checkout fixture.",
    shortDescription: "Manual pickup checkout fixture",
    slug: "commerce-e2e-manual",
    price: 32,
    sku: "E2E-MANUAL",
    currency: "CAD",
    variantModel: "concrete",
    isAvailable: true,
    availabilityLabel: "In stock",
    shipping: { fulfillmentMode: "manual" },
    displayOrder: 3,
  },
];

export function getCommerceE2eCatalogFixture(): TProduct[] | null {
  if (process.env.COMMERCE_E2E_CATALOG_FIXTURE !== "1") return null;
  assertFixtureRuntimeIsIsolated();
  return PRODUCTS.map(cloneProduct);
}

function assertFixtureRuntimeIsIsolated(): void {
  if (
    process.env.VERCEL_ENV === "production" ||
    process.env.NEXT_PUBLIC_SANITY_DATASET === "production"
  ) {
    throw new Error("Commerce E2E catalog fixture cannot run in production");
  }
  const databaseUrl = process.env.DATABASE_URL;
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (
    process.env.COMMERCE_E2E_ISOLATED_TEST_DATABASE !== "1" ||
    !databaseUrl ||
    !testDatabaseUrl ||
    databaseIdentity(databaseUrl) !== databaseIdentity(testDatabaseUrl)
  ) {
    throw new Error(
      "Commerce E2E catalog fixture requires the explicitly isolated test database",
    );
  }
}

function databaseIdentity(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.username}@${url.hostname}:${url.port}${url.pathname}`;
}

function cloneProduct(product: TProduct): TProduct {
  return {
    ...product,
    ...(product.shipping ? { shipping: { ...product.shipping } } : {}),
    ...(product.collections
      ? {
          collections: product.collections.map((collection) => ({
            ...collection,
          })),
        }
      : {}),
    ...(product.variants
      ? { variants: product.variants.map((variant) => ({ ...variant })) }
      : {}),
  };
}
