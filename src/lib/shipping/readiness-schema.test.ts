import assert from "node:assert/strict";
import test from "node:test";

import {
  privateShippingSchemaIsCurrent,
  REQUIRED_PRIVATE_SCHEMA_MIGRATION_AT,
} from "./readiness-schema";

test("shipping readiness requires the Helcim reconciliation retention cleanup from 0061", () => {
  assert.equal(REQUIRED_PRIVATE_SCHEMA_MIGRATION_AT, 1786829940203);
  assert.equal(privateShippingSchemaIsCurrent(1786824274642), false);
  assert.equal(privateShippingSchemaIsCurrent(1786829940203), true);
});
