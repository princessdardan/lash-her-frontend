import assert from "node:assert";
import { describe, it } from "node:test";

import { product } from "./product";

type SchemaField = {
  name?: string;
  type?: string;
  of?: SchemaField[];
  fields?: SchemaField[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSchemaField(value: unknown): value is SchemaField {
  return isRecord(value) && (value.name === undefined || typeof value.name === "string");
}

function getSchemaField(name: string): SchemaField {
  const schemaField = product.fields.find(
    (field: unknown) => isSchemaField(field) && field.name === name,
  );

  if (!isSchemaField(schemaField)) {
    assert.fail(`${name} field should be configured`);
  }

  return schemaField;
}

describe("product schema", () => {
  it("supports optional merchant SKUs for canonical checkout reconciliation", () => {
    const sku = getSchemaField("sku");

    assert.strictEqual(sku.type, "string");
  });

  it("supports optional variant SKUs without requiring customer-facing generated codes", () => {
    const variants = getSchemaField("variants");
    const variantObject = variants.of?.find((member) => member.type === "object");
    const variantMember = variantObject?.fields?.find((field) => field.name === "sku");

    assert.strictEqual(variantMember?.type, "string");
  });
});
