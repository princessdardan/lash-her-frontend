import assert from "node:assert";
import { describe, it } from "node:test";

import {
  product,
  validateOptionGroupNames,
  validateProductCheckoutConfiguration,
  validateProductVariantConfiguration,
} from "./product";

type SchemaField = {
  description?: string;
  name?: string;
  title?: string;
  type?: string;
  of?: SchemaField[];
  fields?: SchemaField[];
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
  it("supports optional merchant SKUs for canonical checkout reconciliation", () => {
    const sku = getSchemaField("sku");

    assert.strictEqual(sku.type, "string");
  });

  it("supports optional variant SKUs without requiring customer-facing generated codes", () => {
    const variants = getSchemaField("variants");
    const variantObject = variants.of?.find(
      (member) => member.type === "object",
    );
    const variantMember = variantObject?.fields?.find(
      (field) => field.name === "sku",
    );

    assert.strictEqual(variantMember?.type, "string");
  });

  it("gives every shipping and customs field clear editor guidance", () => {
    const shipping = getSchemaField("shipping");
    const expectedFields = [
      "fulfillmentMode",
      "weightGrams",
      "packingUnits",
      "minimumPackageTier",
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
      "usRegulatoryCertification",
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

    const packingUnits = shipping.fields?.find(
      (field) => field.name === "packingUnits",
    );
    assert.match(packingUnits?.description ?? "", /multiplies.*quantity/i);
    assert.match(packingUnits?.description ?? "", /lash tray/i);
  });

  it("requires an explicit variant authoring model when variants are present", () => {
    const variantModel = getSchemaField("variantModel");

    assert.strictEqual(variantModel.type, "string");
  });

  it("validates grouped authoring constraints before publish", () => {
    const groupedVariants = [
      {
        title: "Curl",
        price: 22,
        isAvailable: true,
        options: [{ name: "C" }, { name: "CC" }],
      },
      {
        title: "Length",
        price: 22,
        isAvailable: true,
        options: [{ name: "8mm" }, { name: "9mm" }],
      },
    ];

    assert.strictEqual(
      validateProductVariantConfiguration(groupedVariants, {
        variantModel: "grouped",
        optionGroups: [{ name: "Curl" }, { name: "Length" }],
      }),
      true,
    );
    assert.match(
      String(
        validateProductVariantConfiguration(
          [{ ...groupedVariants[0], sku: "GROUP-SKU" }, groupedVariants[1]],
          { variantModel: "grouped" },
        ),
      ),
      /cannot define merchant SKUs/,
    );
    assert.match(
      String(
        validateProductVariantConfiguration(
          [groupedVariants[0], { ...groupedVariants[1], price: 23 }],
          { variantModel: "grouped" },
        ),
      ),
      /same price/,
    );

    assert.strictEqual(
      validateProductVariantConfiguration(
        [
          {
            title: "Finish",
            price: 22,
            isAvailable: true,
            options: [{ name: "Natural" }, { name: "Glossy" }],
          },
          {
            title: "Style",
            price: 22,
            isAvailable: true,
            options: [{ name: "Natural" }, { name: "Dramatic" }],
          },
        ],
        { variantModel: "grouped" },
      ),
      true,
    );
  });

  it("rejects empty variant configurations that expose unpurchasable options", () => {
    assert.match(
      String(
        validateProductVariantConfiguration([], { variantModel: "grouped" }),
      ),
      /requires at least one grouped Variant row/,
    );
    assert.match(
      String(
        validateProductVariantConfiguration(undefined, {
          variantModel: "concrete",
          optionGroups: [{ name: "Curl", values: ["C", "CC"] }],
        }),
      ),
      /Option Groups require concrete Variants/,
    );
  });

  it("rejects incomplete or duplicate concrete option tuples", () => {
    assert.match(
      String(
        validateProductVariantConfiguration(
          [
            {
              title: "C / 8mm",
              options: [{ name: "Curl", value: "C" }, { name: "Length" }],
            },
          ],
          { variantModel: "concrete" },
        ),
      ),
      /both a non-blank group name and selected value/,
    );

    assert.match(
      String(
        validateProductVariantConfiguration(
          [
            {
              title: "First",
              options: [{ name: "Curl", value: "C" }],
            },
            {
              title: "Duplicate",
              options: [{ name: "Curl", value: "C" }],
            },
          ],
          { variantModel: "concrete" },
        ),
      ),
      /unique option combinations/,
    );
  });

  it("rejects duplicate option-group names and values", () => {
    assert.match(
      String(validateOptionGroupNames([{ name: "Curl", values: ["C", "c"] }])),
      /must be unique/,
    );
    assert.match(
      String(validateOptionGroupNames([{ name: "Curl" }, { name: "curl" }])),
      /names must be unique/,
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
      /metadata is complete.*missing_packing_units/i,
    );
    assert.strictEqual(
      validateProductCheckoutConfiguration({
        isAvailable: true,
        shipping: { fulfillmentMode: "manual" },
      }),
      true,
    );
  });

  it("requires complete variant overrides and U.S. approval data", () => {
    const baseShipping = {
      fulfillmentMode: "physical",
      weightGrams: 35,
      packingUnits: 1,
      customsDescription: "Synthetic eyelash extensions",
      countryOfOrigin: "KR",
    };
    assert.match(
      String(
        validateProductCheckoutConfiguration({
          isAvailable: true,
          shipping: baseShipping,
          variants: [
            {
              title: "C / 8mm",
              isAvailable: true,
              shipping: { fulfillmentMode: "physical", weightGrams: 40 },
            },
          ],
        }),
      ),
      /C \/ 8mm.*missing_packing_units/i,
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

    assert.match(
      String(
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
      ),
      /missing_us_regulatory_certification/i,
    );
  });
});
