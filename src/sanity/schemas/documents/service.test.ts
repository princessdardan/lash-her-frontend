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
});
