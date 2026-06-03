import assert from "node:assert";
import { describe, it } from "node:test";

import { service } from "./service";

type ValidationResult = true | string;

type ValidationDocument = {
  depositAmount?: number;
  fullPrice?: number;
};

type ValidationContextStub = {
  document?: ValidationDocument;
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
  validation?: (rule: RuleStub) => unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSchemaField(value: unknown): value is SchemaField {
  return isRecord(value) && (value.name === undefined || typeof value.name === "string");
}

function getFields(): SchemaField[] {
  return service.fields.map((field: unknown) => {
    if (!isSchemaField(field)) {
      assert.fail("service fields should be schema fields");
    }

    return field;
  });
}

function getField(name: string): SchemaField {
  const field = getFields().find((candidate) => candidate.name === name);

  if (!field) {
    assert.fail(`${name} field should be configured`);
  }

  return field;
}

function getFieldValidator(name: string): FieldValidator {
  const field = getField(name);

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

function buildContext(document?: ValidationDocument): ValidationContextStub {
  return { document };
}

describe("service schema payment contract", () => {
  it("does not expose a service-level payment mode", () => {
    const fieldNames = getFields().map((field) => field.name);

    assert.ok(!fieldNames.includes("paymentMode"));
    assert.ok(!fieldNames.includes("allowCustomAmount"));
    assert.ok(!fieldNames.includes("customAmountMinimum"));
    assert.ok(!fieldNames.includes("customAmountMaximum"));
    assert.ok(fieldNames.includes("depositAmount"));
    assert.ok(fieldNames.includes("fullPrice"));
  });

  it("requires a positive deposit amount below the full price", async () => {
    const validator = getFieldValidator("depositAmount");

    assert.strictEqual(await validator(undefined, buildContext({ fullPrice: 250 })), "Deposit amount is required.");
    assert.strictEqual(await validator(0, buildContext({ fullPrice: 250 })), "Deposit amount must be greater than zero.");
    assert.strictEqual(await validator(250, buildContext({ fullPrice: 250 })), "Deposit amount must be less than the full price.");
    assert.strictEqual(await validator(50, buildContext({ fullPrice: 250 })), true);
  });

  it("requires a positive full price above the deposit amount", async () => {
    const validator = getFieldValidator("fullPrice");

    assert.strictEqual(await validator(undefined, buildContext({ depositAmount: 50 })), "Full price is required.");
    assert.strictEqual(await validator(0, buildContext({ depositAmount: 50 })), "Full price must be greater than zero.");
    assert.strictEqual(await validator(50, buildContext({ depositAmount: 50 })), "Full price must be greater than the deposit amount.");
    assert.strictEqual(await validator(250, buildContext({ depositAmount: 50 })), true);
  });

  it("defines embedded service add-ons with required public fields", () => {
    const addOnsField = getField("addOns") as SchemaField & {
      type?: string;
      of?: Array<{ type?: string; fields?: SchemaField[] }>;
    };

    assert.equal(addOnsField.type, "array");
    assert.ok(Array.isArray(addOnsField.of));
    assert.equal(addOnsField.of?.[0]?.type, "object");

    const addOnFields = addOnsField.of?.[0]?.fields ?? [];
    const addOnFieldNames = addOnFields.map((field) => field.name);

    assert.ok(addOnFieldNames.includes("name"));
    assert.ok(addOnFieldNames.includes("description"));
    assert.ok(addOnFieldNames.includes("image"));
    assert.ok(addOnFieldNames.includes("price"));
    assert.ok(!addOnFieldNames.includes("isAvailable"));
  });

  it("requires positive add-on prices", async () => {
    const addOnsField = getField("addOns") as SchemaField & {
      of?: Array<{ fields?: SchemaField[] }>;
    };
    const priceField = addOnsField.of?.[0]?.fields?.find((field) => field.name === "price");

    assert.ok(priceField, "add-on price field should be configured");
    assert.equal(typeof priceField.validation, "function");

    let capturedValidator: FieldValidator | undefined;
    const rule: RuleStub = {
      custom(validator) {
        capturedValidator = validator;
        return rule;
      },
    };

    priceField.validation(rule);
    assert.ok(capturedValidator, "add-on price custom validator should be registered");
    assert.strictEqual(await capturedValidator(undefined, buildContext()), "Add-on price is required.");
    assert.strictEqual(await capturedValidator(0, buildContext()), "Add-on price must be greater than zero.");
    assert.strictEqual(await capturedValidator(25, buildContext()), true);
  });
});
