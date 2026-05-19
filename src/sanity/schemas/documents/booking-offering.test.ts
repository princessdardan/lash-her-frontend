import assert from "node:assert";
import { describe, it } from "node:test";

import {
  BOOKING_OFFERING_PAYMENT_MODE_OPTIONS,
  bookingOffering,
} from "./booking-offering";

type ValidationResult = true | string;

type ReferenceValue = {
  _ref: string;
};

type ValidationDocument = {
  paymentMode?: string;
  depositProduct?: ReferenceValue;
  fullProduct?: ReferenceValue;
};

type ValidationContextStub = {
  document?: ValidationDocument;
  getClient: (config: { apiVersion: string }) => {
    fetch: <T>(query: string, params: Record<string, string>) => Promise<T>;
  };
};

type ProductProjection = {
  kind?: string;
  price?: number;
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

function buildContext(products: Record<string, ProductProjection | null>, document?: ValidationDocument) {
  return {
    document,
    getClient: ({ apiVersion }: { apiVersion: string }) => {
      assert.strictEqual(apiVersion, "2026-03-24");

      return {
        async fetch<T>(query: string, params: Record<string, string>): Promise<T> {
          assert.match(query, /\*\[_id == \$productId\]/);
          return products[params.productId] as T;
        },
      };
    },
  };
}

describe("bookingOffering schema", () => {
  it("defines the expected editorial fields without private booking data", () => {
    assert.strictEqual(bookingOffering.name, "bookingOffering");
    assert.strictEqual(bookingOffering.type, "document");

    const fieldNames = getFields().map((field) => field.name);

    assert.deepStrictEqual(fieldNames, [
      "title",
      "description",
      "slug",
      "isActive",
      "bookingType",
      "durationMinutes",
      "slotIntervalMinutes",
      "bufferBeforeMinutes",
      "bufferAfterMinutes",
      "minimumLeadTimeHoursOverride",
      "paymentMode",
      "depositProduct",
      "fullProduct",
      "displayOrder",
    ]);

    const forbiddenFields = [
      "customerName",
      "customerEmail",
      "customerPhone",
      "paymentState",
      "holdState",
      "bookingHistory",
      "transactionId",
      "paymentToken",
    ];

    for (const forbiddenField of forbiddenFields) {
      assert.ok(!fieldNames.includes(forbiddenField), `${forbiddenField} must not be stored in Sanity`);
    }
  });

  it("limits booking and payment mode options to the v1 contract", () => {
    assert.deepStrictEqual(BOOKING_OFFERING_PAYMENT_MODE_OPTIONS, [
      { title: "Deposit", value: "deposit" },
      { title: "Full payment", value: "full" },
      { title: "Customer choice", value: "choice" },
    ]);

    assert.deepStrictEqual(getField("paymentMode").options?.list, BOOKING_OFFERING_PAYMENT_MODE_OPTIONS);
    assert.deepStrictEqual(getField("bookingType").options?.list, [
      { title: "Training sign-up call", value: "training-call" },
      { title: "In-person appointment", value: "in-person-appointment" },
    ]);
  });

  it("uses sellable product references for payment products", () => {
    assert.strictEqual(getField("depositProduct").type, "reference");
    assert.deepStrictEqual(getField("depositProduct").to, [{ type: "sellableProduct" }]);
    assert.strictEqual(getField("fullProduct").type, "reference");
    assert.deepStrictEqual(getField("fullProduct").to, [{ type: "sellableProduct" }]);
  });

  it("validates deposit product references as deposit products", async () => {
    const validator = getFieldValidator("depositProduct");
    const reference = { _ref: "deposit-product" };

    assert.strictEqual(
      await validator(undefined, buildContext({}, { paymentMode: "deposit" })),
      "A deposit product is required for deposit and choice payment modes.",
    );
    assert.strictEqual(
      await validator(reference, buildContext({ "deposit-product": null })),
      "The selected deposit product could not be found. Choose an existing deposit product.",
    );
    assert.strictEqual(
      await validator(reference, buildContext({ "deposit-product": { kind: "service", price: 50 } })),
      "Deposit product must reference a sellable product with Kind set to Deposit.",
    );
    assert.strictEqual(
      await validator(reference, buildContext({ "deposit-product": { kind: "deposit", price: 50 } })),
      true,
    );
  });

  it("validates full payment product references as service or deposit products", async () => {
    const validator = getFieldValidator("fullProduct");
    const reference = { _ref: "full-product" };

    assert.strictEqual(
      await validator(undefined, buildContext({}, { paymentMode: "full" })),
      "A full payment product is required for full and choice payment modes.",
    );
    assert.strictEqual(
      await validator(reference, buildContext({ "full-product": null })),
      "The selected full payment product could not be found. Choose an existing service product.",
    );
    assert.strictEqual(
      await validator(reference, buildContext({ "full-product": { kind: "training", price: 250 } })),
      "Full payment product must reference a sellable product with Kind set to Service or Deposit.",
    );
    assert.strictEqual(
      await validator(reference, buildContext({ "full-product": { kind: "service", price: 250 } })),
      true,
    );
  });

  it("allows choice mode only when full payment exceeds deposit", async () => {
    const validator = getFieldValidator("paymentMode");
    const document = {
      paymentMode: "choice",
      depositProduct: { _ref: "deposit-product" },
      fullProduct: { _ref: "full-product" },
    };

    assert.strictEqual(await validator("deposit", buildContext({})), true);
    assert.strictEqual(
      await validator("choice", buildContext({}, { paymentMode: "choice" })),
      "Choice payment mode requires both deposit and full payment products.",
    );
    assert.strictEqual(
      await validator(
        "choice",
        buildContext(
          {
            "deposit-product": { kind: "deposit", price: 100 },
            "full-product": { kind: "service", price: 100 },
          },
          document,
        ),
      ),
      "Choice payment mode requires the full payment product price to exceed the deposit product price.",
    );
    assert.strictEqual(
      await validator(
        "choice",
        buildContext(
          {
            "deposit-product": { kind: "deposit", price: 100 },
            "full-product": { kind: "service", price: 250 },
          },
          document,
        ),
      ),
      true,
    );
  });
});
