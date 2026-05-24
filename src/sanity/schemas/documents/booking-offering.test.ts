import assert from "node:assert";
import { describe, it } from "node:test";

import { bookingOffering } from "./booking-offering";

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
  required: () => RuleStub;
  custom: (validator: FieldValidator) => RuleStub;
};

type SchemaField = {
  name?: string;
  type?: string;
  options?: {
    list?: Array<string | { title: string; value: string }>;
  };
  to?: Array<{ type: string }>;
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

function getFields(): SchemaField[] {
  return bookingOffering.fields.map((field: unknown) => {
    if (!isSchemaField(field)) {
      assert.fail("bookingOffering fields should be schema fields");
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
    required() {
      return rule;
    },
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

describe("bookingOffering schema", () => {
  it("defines native booking payment fields without private booking data", () => {
    assert.strictEqual(bookingOffering.name, "bookingOffering");
    assert.strictEqual(bookingOffering.type, "document");

    const fieldNames = getFields().map((field) => field.name);

    assert.deepStrictEqual(fieldNames, [
      "title",
      "description",
      "slug",
      "service",
      "isActive",
      "bookingType",
      "durationMinutes",
      "slotIntervalMinutes",
      "bufferBeforeMinutes",
      "bufferAfterMinutes",
      "minimumLeadTimeHoursOverride",
      "depositAmount",
      "fullPrice",
      "currency",
      "displayOrder",
    ]);

    for (const forbiddenField of [
      "customerName",
      "customerEmail",
      "customerPhone",
      "paymentState",
      "holdState",
      "bookingHistory",
      "transactionId",
      "paymentToken",
    ]) {
      assert.ok(!fieldNames.includes(forbiddenField), `${forbiddenField} must not be stored in Sanity`);
    }
  });

  it("limits booking type options to the canonical contract", () => {
    assert.deepStrictEqual(getField("bookingType").options?.list, [
      { title: "Training sign-up call", value: "training-call" },
      { title: "In-person appointment", value: "in-person-appointment" },
    ]);
  });

  it("requires a canonical service reference", () => {
    const serviceField = getField("service");

    assert.strictEqual(serviceField.type, "reference");
    assert.deepStrictEqual(serviceField.to, [{ type: "service" }]);
  });

  it("does not expose product reference wrappers", () => {
    const fieldNames = getFields().map((field) => field.name);

    assert.ok(!fieldNames.includes("depositProduct"));
    assert.ok(!fieldNames.includes("fullProduct"));
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
