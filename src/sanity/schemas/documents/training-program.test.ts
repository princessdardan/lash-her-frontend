import assert from "node:assert";
import { describe, it } from "node:test";

import { trainingProgram } from "./training-program";

type ValidationResult = true | string;

type ValidationContextStub = {
  document?: { checkoutEnabled?: boolean };
};

type FieldValidator = (
  value: unknown,
  context: ValidationContextStub,
) => ValidationResult | Promise<ValidationResult>;

type RuleStub = {
  custom: (validator: FieldValidator) => RuleStub;
};

type SchemaField = {
  name?: string;
  group?: string;
  of?: Array<{ type?: string }>;
  fields?: SchemaField[];
  validation?: (rule: RuleStub) => unknown;
  hidden?: unknown;
  readOnly?: unknown;
  deprecated?: { reason?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSchemaField(value: unknown): value is SchemaField {
  return isRecord(value) && (value.name === undefined || typeof value.name === "string");
}

function getFieldValidator(name: string): FieldValidator {
  const field = getSchemaField(name);

  if (typeof field.validation !== "function") {
    assert.fail(`${name} validation should be configured`);
  }

  let capturedValidator: FieldValidator | undefined;
  const rule: RuleStub = {
    custom(validator) {
      capturedValidator = validator;
      return rule;
    },
  };

  field.validation(rule);
  assert.ok(capturedValidator, `${name} custom validator should be registered`);
  return capturedValidator;
}

function getSchemaField(name: string): SchemaField {
  const fields = trainingProgram.fields.map((field: unknown) => field);
  const schemaField = fields.find(
    (field) => isSchemaField(field) && field.name === name,
  );

  if (!isSchemaField(schemaField)) {
    assert.fail(`${name} field should be configured`);
  }

  return schemaField;
}

function buildContext(document: { checkoutEnabled?: boolean } = { checkoutEnabled: true }): ValidationContextStub {
  return { document };
}

describe("trainingProgram native commerce validation", () => {
  it("requires native price only when checkout is enabled", async () => {
    const validator = getFieldValidator("price");

    assert.strictEqual(await validator(undefined, buildContext()), "Training checkout requires a positive native price.");
    assert.strictEqual(await validator(0, buildContext()), "Training checkout requires a positive native price.");
    assert.strictEqual(await validator(1200, buildContext()), true);
    assert.strictEqual(await validator(undefined, buildContext({ checkoutEnabled: false })), true);
  });

  it("requires CAD currency only when checkout is enabled", async () => {
    const validator = getFieldValidator("currency");

    assert.strictEqual(await validator("USD", buildContext()), "Training checkout currency must be CAD.");
    assert.strictEqual(await validator("CAD", buildContext()), true);
    assert.strictEqual(await validator(undefined, buildContext({ checkoutEnabled: false })), true);
  });

  it("requires availability only when checkout is enabled", async () => {
    const validator = getFieldValidator("isAvailable");

    assert.strictEqual(await validator(undefined, buildContext()), "Set whether this training program is available for checkout.");
    assert.strictEqual(await validator(true, buildContext()), true);
    assert.strictEqual(await validator(false, buildContext()), true);
  });
});

describe("trainingProgram detail content schema", () => {
  it("configures native checkout commerce fields without requiring the legacy fallback", () => {
    const schemaFieldNames = trainingProgram.fields
      .map((field: unknown) => isSchemaField(field) ? field.name : undefined)
      .filter((name): name is string => typeof name === "string");

    for (const fieldName of [
      "price",
      "currency",
      "isAvailable",
      "availabilityLabel",
      "fulfillmentNote",
      "displayOrder",
      "image",
    ]) {
      assert.strictEqual(getSchemaField(fieldName).group, "commerce", `${fieldName} should be in the commerce group`);
    }

    assert.ok(!schemaFieldNames.includes("checkoutProduct"));
  });

  it("configures a detail hero image in the details group", () => {
    const detailHeroImage = getSchemaField("detailHeroImage");

    assert.strictEqual(detailHeroImage.group, "details");
    assert.ok(
      detailHeroImage.fields?.some((field) => field.name === "alt"),
      "detailHeroImage should expose alt text for accessibility",
    );
  });

  it("keeps contact form blocks but removes legacy training hero and info blocks", () => {
    const blocks = getSchemaField("blocks");
    const allowedTypes = blocks.of?.map((member) => member.type) ?? [];

    assert.deepStrictEqual(allowedTypes, ["contactFormLabels"]);
  });
});
