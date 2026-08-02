import assert from "node:assert";
import { describe, it } from "node:test";

import { canonicalizeServiceSlug, service } from "./service";

type SchemaField = {
  name?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSchemaField(value: unknown): value is SchemaField {
  return (
    isRecord(value) &&
    (value.name === undefined || typeof value.name === "string")
  );
}

function getFields(): SchemaField[] {
  return service.fields.map((field: unknown) => {
    if (!isSchemaField(field)) {
      assert.fail("service fields should be schema fields");
    }

    return field;
  });
}

describe("service schema editorial contract", () => {
  it("normalizes generated service slugs to operational URL keys", () => {
    assert.equal(canonicalizeServiceSlug(" Full Sét "), "full-set");
    assert.equal(
      canonicalizeServiceSlug("Mobile Appointment "),
      "mobile-appointment",
    );
    assert.equal(canonicalizeServiceSlug("Brow---Waxing"), "brow-waxing");
  });

  it("contains only service detail-page editorial fields", () => {
    const fieldNames = getFields().map((field) => field.name);

    assert.deepEqual(fieldNames, [
      "title",
      "slug",
      "description",
      "shortDescription",
      "image",
      "gallery",
      "detailSections",
      "seo",
    ]);
  });

  it("does not expose commerce, availability, ordering, or booking controls", () => {
    const fieldNames = getFields().map((field) => field.name);

    for (const fieldName of [
      "addOns",
      "currency",
      "depositAmount",
      "displayOrder",
      "durationMinutes",
      "fullPrice",
      "isAvailable",
      "showDetailPage",
    ]) {
      assert.ok(
        !fieldNames.includes(fieldName),
        `${fieldName} should not be configured`,
      );
    }
  });
});
