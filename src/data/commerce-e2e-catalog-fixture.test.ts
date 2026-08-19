import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMERCE_E2E_FDA_REQUIREMENTS_VERSION,
  COMMERCE_E2E_TARIFF_SCHEMA_VERSION,
  COMMERCE_E2E_US_CONTRACT_VERSION,
  getCommerceE2eCatalogFixture,
} from "./commerce-e2e-catalog-fixture";

const ENV_NAMES = [
  "COMMERCE_E2E_CATALOG_FIXTURE",
  "COMMERCE_E2E_ISOLATED_TEST_DATABASE",
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "VERCEL_ENV",
  "NEXT_PUBLIC_SANITY_DATASET",
] as const;

test("commerce catalog fixture is opt-in and requires an isolated non-production database", () => {
  withFixtureEnvironment(() => {
    delete process.env.COMMERCE_E2E_CATALOG_FIXTURE;
    assert.equal(getCommerceE2eCatalogFixture(), null);

    process.env.COMMERCE_E2E_CATALOG_FIXTURE = "1";
    assert.throws(
      () => getCommerceE2eCatalogFixture(),
      /explicitly isolated test database/,
    );

    process.env.COMMERCE_E2E_ISOLATED_TEST_DATABASE = "1";
    process.env.DATABASE_URL = "postgresql://test@127.0.0.1:5432/commerce_e2e";
    process.env.TEST_DATABASE_URL =
      "postgresql://test@127.0.0.1:5432/commerce_e2e?sslmode=disable";
    process.env.VERCEL_ENV = "production";
    assert.throws(
      () => getCommerceE2eCatalogFixture(),
      /cannot run in production/,
    );
  });
});

test("commerce catalog fixture exposes automated Canada, certified U.S. DDU, and manual products", () => {
  withFixtureEnvironment(() => {
    process.env.COMMERCE_E2E_CATALOG_FIXTURE = "1";
    process.env.COMMERCE_E2E_ISOLATED_TEST_DATABASE = "1";
    process.env.DATABASE_URL =
      "postgresql://test@127.0.0.1:5432/commerce_e2e?application_name=app";
    process.env.TEST_DATABASE_URL =
      "postgresql://test@127.0.0.1:5432/commerce_e2e?application_name=tests";
    process.env.VERCEL_ENV = "preview";
    process.env.NEXT_PUBLIC_SANITY_DATASET = "staging-2026-05-10";

    const products = getCommerceE2eCatalogFixture();
    assert.equal(products?.length, 3);
    assert.equal(products?.[0]?.shipping?.fulfillmentMode, "physical");
    const usCertification = products?.[1]?.shipping?.usRegulatoryCertification;
    assert.equal(
      usCertification?.usShippingContractVersion,
      COMMERCE_E2E_US_CONTRACT_VERSION,
    );
    assert.equal(
      usCertification?.tariffMetadataSchemaVersion,
      COMMERCE_E2E_TARIFF_SCHEMA_VERSION,
    );
    assert.equal(
      usCertification?.fdaRequirementsVersion,
      COMMERCE_E2E_FDA_REQUIREMENTS_VERSION,
    );
    assert.equal(products?.[2]?.shipping?.fulfillmentMode, "manual");
  });
});

function withFixtureEnvironment(run: () => void): void {
  const previous = Object.fromEntries(
    ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of ENV_NAMES) delete process.env[name];
    run();
  } finally {
    for (const name of ENV_NAMES) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
