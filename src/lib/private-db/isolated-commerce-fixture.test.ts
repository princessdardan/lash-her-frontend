import assert from "node:assert/strict";
import test from "node:test";
import { assertIsolatedCommerceFixtureDatabase } from "./isolated-commerce-fixture";

const valid = () => ({ COMMERCE_E2E_ENABLED_MODE: "1", COMMERCE_E2E_ISOLATED_TEST_DATABASE: "1",
  DATABASE_URL: "postgres://fixture:unused@127.0.0.1:5432/lash_her_browser_ci?sslmode=disable",
  TEST_DATABASE_URL: "postgresql://fixture:unused@127.0.0.1/lash_her_browser_ci" });
test("fixture seed accepts matching owned loopback identities without a provider environment", () => {
  assert.doesNotThrow(() => assertIsolatedCommerceFixtureDatabase(valid()));
});
test("fixture seed rejects remote, ordinary local, production and URL-override bypasses", () => {
  for (const patch of [
    { DATABASE_URL: "postgres://fixture:unused@database.invalid/lash_her_browser_ci" },
    { DATABASE_URL: "postgres://fixture:unused@127.0.0.1/customer_data" },
    { DATABASE_URL: valid().DATABASE_URL + "&host=database.invalid" },
    { DATABASE_URL: valid().DATABASE_URL + "&options=-c%20role%3Doperator" },
    { TEST_DATABASE_URL: "postgres://another:unused@127.0.0.1/lash_her_browser_ci" },
    { APP_ENV: "staging" }, { VERCEL_TARGET_ENV: "production" }, { COMMERCE_E2E_ISOLATED_TEST_DATABASE: "0" },
  ]) assert.throws(() => assertIsolatedCommerceFixtureDatabase({ ...valid(), ...patch }), /isolated loopback/);
});
