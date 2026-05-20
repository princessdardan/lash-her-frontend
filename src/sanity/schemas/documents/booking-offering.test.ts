import assert from "node:assert";
import { describe, it } from "node:test";

import {
  BOOKING_OFFERING_PAYMENT_MODE_OPTIONS,
  bookingOffering,
} from "./booking-offering";

type ValidationResult = true | string;

type ValidationDocument = {
  paymentMode?: string;
  depositAmount?: number;
  fullPrice?: number;
  allowCustomAmount?: boolean;
  customAmountMinimum?: number;
  customAmountMaximum?: number;
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
      "paymentMode",
      "depositAmount",
      "fullPrice",
      "allowCustomAmount",
      "customAmountMinimum",
      "customAmountMaximum",
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

  it("limits booking and payment mode options to the canonical contract", () => {
    assert.deepStrictEqual(BOOKING_OFFERING_PAYMENT_MODE_OPTIONS, [
      { title: "Deposit", value: "deposit" },
      { title: "Full payment", value: "full" },
      { title: "Custom partial payment", value: "customPartial" },
    ]);

    assert.deepStrictEqual(getField("paymentMode").options?.list, BOOKING_OFFERING_PAYMENT_MODE_OPTIONS);
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

  it("does not expose legacy sellable product references", () => {
    const fieldNames = getFields().map((field) => field.name);

    assert.ok(!fieldNames.includes("depositProduct"));
    assert.ok(!fieldNames.includes("fullProduct"));
  });

  it("validates deposit amounts only for deposit mode", async () => {
    const validator = getFieldValidator("depositAmount");

    assert.strictEqual(await validator(undefined, buildContext({ paymentMode: "deposit" })), "Deposit payment mode requires a positive deposit amount.");
    assert.strictEqual(await validator(0, buildContext({ paymentMode: "deposit" })), "Deposit amount must be greater than zero.");
    assert.strictEqual(await validator(50, buildContext({ paymentMode: "deposit" })), true);
    assert.strictEqual(await validator(undefined, buildContext({ paymentMode: "full" })), true);
  });

  it("validates full price for full and custom partial modes", async () => {
    const validator = getFieldValidator("fullPrice");

    assert.strictEqual(await validator(undefined, buildContext({ paymentMode: "full" })), "Full payment and custom partial modes require a positive full price.");
    assert.strictEqual(await validator(0, buildContext({ paymentMode: "customPartial" })), "Full price must be greater than zero.");
    assert.strictEqual(await validator(250, buildContext({ paymentMode: "full" })), true);
    assert.strictEqual(await validator(undefined, buildContext({ paymentMode: "deposit" })), true);
  });

  it("validates custom partial amount bounds", async () => {
    const minimumValidator = getFieldValidator("customAmountMinimum");
    const maximumValidator = getFieldValidator("customAmountMaximum");

    assert.strictEqual(await minimumValidator(undefined, buildContext({ paymentMode: "customPartial" })), "Custom partial mode requires a positive minimum amount.");
    assert.strictEqual(await maximumValidator(undefined, buildContext({ paymentMode: "customPartial" })), "Custom partial mode requires a maximum amount greater than the minimum.");
    assert.strictEqual(await minimumValidator(300, buildContext({ paymentMode: "customPartial", fullPrice: 250 })), "Custom partial minimum must be less than the full price.");
    assert.strictEqual(await maximumValidator(50, buildContext({ paymentMode: "customPartial", customAmountMinimum: 100 })), "Custom partial maximum must be greater than the minimum.");
    assert.strictEqual(await maximumValidator(300, buildContext({ paymentMode: "customPartial", fullPrice: 250, customAmountMinimum: 100 })), "Custom partial maximum cannot exceed the full price.");
    assert.strictEqual(await minimumValidator(100, buildContext({ paymentMode: "customPartial", fullPrice: 250 })), true);
    assert.strictEqual(await maximumValidator(200, buildContext({ paymentMode: "customPartial", fullPrice: 250, customAmountMinimum: 100 })), true);
  });
});
