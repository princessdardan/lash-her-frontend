import assert from "node:assert/strict";
import test from "node:test";

import { promotionCode } from "./promotion-code";

test("Sanity promotion codes expose product and training eligibility only", () => {
  const fields = promotionCode.fields as Array<{
    name?: string;
    options?: { list?: Array<{ value?: string }> };
  }>;
  const fieldNames = fields.map((field) => field.name);
  const appliesTo = fields.find((field) => field.name === "appliesTo");
  const appliesToValues =
    appliesTo?.options?.list?.map((option) => option.value) ?? [];

  assert.equal(fieldNames.includes("services"), false);
  assert.equal(appliesToValues.includes("services"), false);
  assert.deepEqual(appliesToValues, [
    "all",
    "products",
    "trainingPrograms",
    "specificItems",
  ]);
});
