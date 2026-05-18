import assert from "node:assert";
import { describe, it } from "node:test";

import { trainingProgram } from "./training-program";

type ValidationResult = true | string;

type ValidationContextStub = {
  document?: { checkoutEnabled?: boolean };
  getClient: (config: { apiVersion: string }) => {
    fetch: <T>(query: string, params: Record<string, string>) => Promise<T>;
  };
};

type CheckoutProductValidator = (
  value: unknown,
  context: ValidationContextStub,
) => ValidationResult | Promise<ValidationResult>;

type RuleStub = {
  custom: (validator: CheckoutProductValidator) => RuleStub;
};

type SchemaField = {
  name?: string;
  validation?: (rule: RuleStub) => unknown;
};

type ProductProjection = {
  kind?: string;
  isAvailable?: boolean;
  currency?: string;
  price?: number;
  variants?: unknown[];
  options?: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSchemaField(value: unknown): value is SchemaField {
  return isRecord(value) && (value.name === undefined || typeof value.name === "string");
}

function getCheckoutProductValidator(): CheckoutProductValidator {
  const fields = trainingProgram.fields.map((field: unknown) => field);
  const checkoutProductField = fields.find(
    (field) => isSchemaField(field) && field.name === "checkoutProduct",
  );

  if (!isSchemaField(checkoutProductField) || typeof checkoutProductField.validation !== "function") {
    assert.fail("checkoutProduct validation should be configured");
  }

  let capturedValidator: CheckoutProductValidator | undefined;
  const rule: RuleStub = {
    custom(validator) {
      capturedValidator = validator;
      return rule;
    },
  };

  checkoutProductField.validation(rule);
  assert.ok(capturedValidator, "checkoutProduct custom validator should be registered");
  return capturedValidator;
}

function buildContext(product: ProductProjection | null): ValidationContextStub {
  return {
    document: { checkoutEnabled: true },
    getClient: ({ apiVersion }) => {
      assert.strictEqual(apiVersion, "2026-03-24");

      return {
        async fetch<T>(query: string, params: Record<string, string>): Promise<T> {
          assert.match(query, /\*\[_id == \$productId\]/);
          assert.deepStrictEqual(params, { productId: "product-training" });
          return product as T;
        },
      };
    },
  };
}

describe("trainingProgram checkoutProduct validation", () => {
  const validProduct: ProductProjection = {
    kind: "training",
    isAvailable: true,
    currency: "CAD",
    price: 1200,
  };

  it("allows disabled checkout without a product", async () => {
    const validator = getCheckoutProductValidator();
    const result = await validator(undefined, {
      document: { checkoutEnabled: false },
      getClient: () => ({
        async fetch<T>(): Promise<T> {
          throw new Error("fetch should not run when checkout is disabled");
        },
      }),
    });

    assert.strictEqual(result, true);
  });

  it("requires a product when checkout is enabled", async () => {
    const validator = getCheckoutProductValidator();
    const result = await validator(undefined, buildContext(validProduct));

    assert.strictEqual(result, "A checkout product is required when checkout is enabled.");
  });

  it("rejects invalid training checkout product references", async () => {
    const validator = getCheckoutProductValidator();
    const reference = { _ref: "product-training" };

    const cases: Array<{ product: ProductProjection | null; message: string }> = [
      {
        product: null,
        message: "The selected checkout product could not be found. Choose an existing training product.",
      },
      {
        product: { ...validProduct, kind: "product" },
        message: "Training checkout requires a sellable product with Kind set to Training.",
      },
      {
        product: { ...validProduct, isAvailable: false },
        message: "Training checkout requires the selected product to be available for checkout.",
      },
      {
        product: { ...validProduct, currency: "USD" },
        message: "Training checkout requires the selected product currency to be CAD.",
      },
      {
        product: { ...validProduct, price: 0 },
        message: "Training checkout requires the selected product price to be a positive number.",
      },
      {
        product: { ...validProduct, variants: [{ title: "Option" }] },
        message: "Training checkout does not support product variants or options. Remove them from the selected product.",
      },
      {
        product: { ...validProduct, options: [{ title: "Legacy Option" }] },
        message: "Training checkout does not support product variants or options. Remove them from the selected product.",
      },
    ];

    for (const testCase of cases) {
      assert.strictEqual(await validator(reference, buildContext(testCase.product)), testCase.message);
    }
  });

  it("accepts a valid training product", async () => {
    const validator = getCheckoutProductValidator();
    const result = await validator({ _ref: "product-training" }, buildContext(validProduct));

    assert.strictEqual(result, true);
  });
});
