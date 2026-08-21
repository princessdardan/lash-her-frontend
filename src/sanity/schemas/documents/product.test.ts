import assert from "node:assert";
import { describe, it } from "node:test";

import {
  product,
  validateOptionAxes,
  validateProductCheckoutConfiguration,
  validateVariantOverrides,
} from "./product";

type SchemaField = {
  description?: string;
  name?: string;
  title?: string;
  type?: string;
  of?: SchemaField[];
  fields?: SchemaField[];
  validation?: unknown;
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
  it("supports optional merchant SKUs for checkout reconciliation", () => {
    const sku = getSchemaField("sku");

    assert.strictEqual(sku.type, "string");
  });

  it("models options as an array of at most two axes", () => {
    const options = getSchemaField("options");

    assert.strictEqual(options.type, "array");
    const optionObject = options.of?.find((member) => member.type === "object");
    const name = optionObject?.fields?.find((field) => field.name === "name");
    const values = optionObject?.fields?.find(
      (field) => field.name === "values",
    );
    assert.strictEqual(name?.type, "string");
    assert.strictEqual(values?.type, "array");
  });

  it("supports optional per-combination override SKUs", () => {
    const overrides = getSchemaField("variantOverrides");
    const overrideObject = overrides.of?.find(
      (member) => member.type === "object",
    );
    const sku = overrideObject?.fields?.find((field) => field.name === "sku");

    assert.strictEqual(sku?.type, "string");
  });

  it("exposes a product-level stock set-point in the catalog group", () => {
    const stockQuantity = getSchemaField("stockQuantity");

    assert.strictEqual(stockQuantity.type, "number");
    assert.strictEqual((stockQuantity as { group?: string }).group, "catalog");
  });

  it("exposes a per-combination stock set-point on the variant override", () => {
    const overrides = getSchemaField("variantOverrides");
    const overrideObject = overrides.of?.find(
      (member) => member.type === "object",
    );
    const stockQuantity = overrideObject?.fields?.find(
      (field) => field.name === "stockQuantity",
    );

    assert.strictEqual(stockQuantity?.type, "number");
  });

  it("gives every shipping and customs field clear editor guidance", () => {
    const shipping = getSchemaField("shipping");
    const expectedFields = [
      "fulfillmentMode",
      "weightGrams",
      "lengthCm",
      "widthCm",
      "heightCm",
      "isRigid",
      "customsDescription",
      "countryOfOrigin",
      "usShippingApproved",
      "hsTariffCode",
      "manufacturerName",
      "manufacturerAddress",
      "manufacturerCity",
      "manufacturerProvinceCode",
      "manufacturerPostalCode",
      "manufacturerCountryCode",
      "hazardousMaterial",
    ];

    assert.match(shipping.description ?? "", /package selection/i);
    for (const fieldName of expectedFields) {
      const field = shipping.fields?.find(
        (candidate) => candidate.name === fieldName,
      );
      assert.ok(field, `${fieldName} should be configured`);
      assert.ok(
        (field.title?.trim().length ?? 0) >= 12,
        `${fieldName} should have a clear heading`,
      );
      assert.ok(
        (field.description?.trim().length ?? 0) >= 80,
        `${fieldName} should have detailed editor guidance`,
      );
    }

    const lengthCm = shipping.fields?.find(
      (field) => field.name === "lengthCm",
    );
    assert.match(lengthCm?.description ?? "", /smallest box/i);
    assert.match(lengthCm?.description ?? "", /lash tray/i);

    const isRigid = shipping.fields?.find((field) => field.name === "isRigid");
    assert.match(isRigid?.description ?? "", /rigid-capable|bendable/i);
  });

  it("accepts zero, one, or two well-formed option axes", () => {
    assert.strictEqual(validateOptionAxes(undefined), true);
    assert.strictEqual(validateOptionAxes([]), true);
    assert.strictEqual(
      validateOptionAxes([{ name: "Size", values: ["S", "M", "L"] }]),
      true,
    );
    assert.strictEqual(
      validateOptionAxes([
        { name: "Curl", values: ["C", "CC"] },
        { name: "Length", values: ["8mm", "9mm"] },
      ]),
      true,
    );
  });

  it("rejects malformed option axes before publish", () => {
    assert.match(
      String(
        validateOptionAxes([
          { name: "Curl", values: ["C"] },
          { name: "Length", values: ["8mm"] },
          { name: "Finish", values: ["Natural"] },
        ]),
      ),
      /at most two options/,
    );
    assert.match(
      String(
        validateOptionAxes([
          { name: "Curl", values: ["C", "CC"] },
          { name: "curl", values: ["D"] },
        ]),
      ),
      /names must be unique/,
    );
    assert.match(
      String(validateOptionAxes([{ name: "Curl", values: ["C", "c"] }])),
      /must be unique/,
    );
    assert.match(
      String(validateOptionAxes([{ name: "Curl", values: [] }])),
      /at least one value/,
    );
  });

  it("validates that overrides pin a real, unique combination", () => {
    const options = [
      { name: "Curl", values: ["C", "CC"] },
      { name: "Length", values: ["8mm", "9mm"] },
    ];

    assert.strictEqual(
      validateVariantOverrides(
        [
          {
            select: [
              { name: "Curl", value: "C" },
              { name: "Length", value: "8mm" },
            ],
            price: 30,
          },
        ],
        { options },
      ),
      true,
    );

    assert.match(
      String(
        validateVariantOverrides([{ select: [{ name: "Curl", value: "C" }] }], {
          options,
        }),
      ),
      /one full combination/,
    );

    assert.match(
      String(
        validateVariantOverrides(
          [
            {
              select: [
                { name: "Curl", value: "C" },
                { name: "Length", value: "12mm" },
              ],
            },
          ],
          { options },
        ),
      ),
      /not a valid value/,
    );

    assert.match(
      String(
        validateVariantOverrides(
          [
            {
              select: [
                { name: "Curl", value: "C" },
                { name: "Length", value: "8mm" },
              ],
            },
            {
              select: [
                { name: "Length", value: "8mm" },
                { name: "Curl", value: "C" },
              ],
            },
          ],
          { options },
        ),
      ),
      /same combination/,
    );

    assert.match(
      String(
        validateVariantOverrides(
          [
            {
              select: [
                { name: "Curl", value: "C" },
                { name: "Length", value: "8mm" },
              ],
              price: 20,
              discountPrice: 25,
            },
          ],
          { options },
        ),
      ),
      /discount price must be lower/,
    );

    // An override that only sets a discount inherits the product price; the
    // discount must still be lower than that inherited price.
    assert.match(
      String(
        validateVariantOverrides(
          [
            {
              select: [
                { name: "Curl", value: "C" },
                { name: "Length", value: "8mm" },
              ],
              discountPrice: 40,
            },
          ],
          { options, price: 30 },
        ),
      ),
      /discount price must be lower/,
    );
  });

  it("rejects overrides on a product with no options", () => {
    assert.match(
      String(
        validateVariantOverrides([{ select: [{ name: "Curl", value: "C" }] }], {
          options: [],
        }),
      ),
      /Add product Options/,
    );
  });

  it("blocks available products with incomplete automated metadata", () => {
    assert.strictEqual(
      validateProductCheckoutConfiguration({
        isAvailable: false,
        shipping: { fulfillmentMode: "physical" },
      }),
      true,
    );
    assert.match(
      String(
        validateProductCheckoutConfiguration({
          isAvailable: true,
          shipping: { fulfillmentMode: "physical", weightGrams: 35 },
        }),
      ),
      /metadata is complete.*missing_dimensions/i,
    );
    assert.strictEqual(
      validateProductCheckoutConfiguration({
        isAvailable: true,
        shipping: { fulfillmentMode: "manual" },
      }),
      true,
    );
  });

  it("requires complete override shipping and U.S. approval data", () => {
    const baseShipping = {
      fulfillmentMode: "physical",
      weightGrams: 35,
      lengthCm: 12,
      widthCm: 8,
      heightCm: 3,
      isRigid: true,
      customsDescription: "Synthetic eyelash extensions",
      countryOfOrigin: "KR",
    };
    assert.match(
      String(
        validateProductCheckoutConfiguration({
          isAvailable: true,
          shipping: baseShipping,
          variantOverrides: [
            {
              select: [
                { name: "Curl", value: "C" },
                { name: "Length", value: "8mm" },
              ],
              isAvailable: true,
              shipping: { fulfillmentMode: "physical", weightGrams: 40 },
            },
          ],
        }),
      ),
      /C \/ 8mm.*missing_dimensions/i,
    );
    assert.match(
      String(
        validateProductCheckoutConfiguration({
          isAvailable: true,
          shipping: { ...baseShipping, usShippingApproved: true },
        }),
      ),
      /U\.S\..*missing_us_hts/i,
    );

    assert.equal(
      validateProductCheckoutConfiguration({
        isAvailable: true,
        shipping: {
          ...baseShipping,
          usShippingApproved: true,
          hsTariffCode: "6704190000",
          manufacturerName: "Reviewed Manufacturer",
          manufacturerAddress: "123 Factory Road",
          manufacturerCity: "Seoul",
          manufacturerProvinceCode: "SE",
          manufacturerPostalCode: "04524",
          manufacturerCountryCode: "KR",
        },
      }),
      true,
    );
  });
});
