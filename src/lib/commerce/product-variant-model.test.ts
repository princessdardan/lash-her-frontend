import assert from "node:assert";
import { describe, it } from "node:test";
import { vercelStegaCombine } from "@vercel/stega";

import type { TProduct, TProductOption, TProductVariant } from "@/types";
import { buildValidatedCart } from "./cart";
import { normalizeProductVariantModel } from "./product-variant-model";

describe("normalizeProductVariantModel", () => {
  it("returns a product with no options untouched", () => {
    const product = createProduct();

    assert.strictEqual(normalizeProductVariantModel(product), product);
  });

  it("strips a stray derived variants array from an options-free product", () => {
    const product = createProduct({
      variants: [
        { _key: "stale", title: "Stale", price: 22, isAvailable: true },
      ],
    });

    const normalized = normalizeProductVariantModel(product);
    assert.strictEqual(normalized.variants, undefined);
  });

  it("expands one axis into a variant per value", () => {
    const normalized = normalizeProductVariantModel(
      createProduct({
        options: [{ _key: "size", name: "Size", values: ["S", "M", "L"] }],
      }),
    );

    assert.equal(normalized.variants?.length, 3);
    assert.deepEqual(
      normalized.variants?.map((variant) => variant.title),
      ["S", "M", "L"],
    );
    assert.ok(
      normalized.variants?.every((variant) => variant.price === 22),
      "combinations inherit the product price by default",
    );
  });

  it("expands two axes into the cartesian product", () => {
    const normalized = normalizeProductVariantModel(createTwoAxisProduct());

    assert.equal(normalized.variants?.length, 4);
    assert.deepEqual(
      normalized.variants?.map((variant) => variant.title),
      ["CC Curl / 8mm", "CC Curl / 9mm", "C Curl / 8mm", "C Curl / 9mm"],
    );
    assert.deepEqual(
      normalized.variants?.[0]?.options?.map((option) => ({
        name: option.name,
        value: option.value,
      })),
      [
        { name: "Curl", value: "CC Curl" },
        { name: "Length", value: "8mm" },
      ],
    );
  });

  it("inherits the product discount price across combinations", () => {
    const normalized = normalizeProductVariantModel(
      createProduct({
        discountPrice: 18,
        options: [{ name: "Size", values: ["S", "M"] }],
      }),
    );

    assert.ok(
      normalized.variants?.every((variant) => variant.discountPrice === 18),
    );
  });

  it("applies a per-combination price override and leaves others on the default", () => {
    const normalized = normalizeProductVariantModel(
      createTwoAxisProduct({
        variantOverrides: [
          {
            select: [
              { name: "Curl", value: "C Curl" },
              { name: "Length", value: "9mm" },
            ],
            price: 30,
          },
        ],
      }),
    );

    const overridden = normalized.variants?.find(
      (variant) => variant.title === "C Curl / 9mm",
    );
    const inherited = normalized.variants?.find(
      (variant) => variant.title === "CC Curl / 8mm",
    );
    assert.equal(overridden?.price, 30);
    assert.equal(inherited?.price, 22);
  });

  it("marks only the targeted combination sold out", () => {
    const normalized = normalizeProductVariantModel(
      createTwoAxisProduct({
        variantOverrides: [
          {
            select: [
              { name: "Curl", value: "CC Curl" },
              { name: "Length", value: "8mm" },
            ],
            isAvailable: false,
            availabilityLabel: "Sold out",
          },
        ],
      }),
    );

    const soldOut = normalized.variants?.find(
      (variant) => variant.title === "CC Curl / 8mm",
    );
    assert.equal(soldOut?.isAvailable, false);
    assert.equal(soldOut?.availabilityLabel, "Sold out");
    assert.equal(
      normalized.variants?.filter((variant) => variant.isAvailable).length,
      3,
    );
  });

  it("carries an override SKU and shipping onto the matched combination only", () => {
    const normalized = normalizeProductVariantModel(
      createTwoAxisProduct({
        variantOverrides: [
          {
            select: [
              { name: "Curl", value: "C Curl" },
              { name: "Length", value: "8mm" },
            ],
            sku: "C-8-SKU",
            shipping: { fulfillmentMode: "physical", weightGrams: 60 },
          },
        ],
      }),
    );

    const overridden = normalized.variants?.find(
      (variant) => variant.title === "C Curl / 8mm",
    );
    assert.equal(overridden?.sku, "C-8-SKU");
    assert.equal(overridden?.shipping?.weightGrams, 60);
    assert.ok(
      normalized.variants
        ?.filter((variant) => variant.title !== "C Curl / 8mm")
        .every(
          (variant) =>
            variant.sku === undefined && variant.shipping === undefined,
        ),
    );
  });

  it("treats an empty override shipping object as no override", () => {
    const normalized = normalizeProductVariantModel(
      createTwoAxisProduct({
        shipping: { fulfillmentMode: "physical", weightGrams: 25 },
        variantOverrides: [
          {
            select: [
              { name: "Curl", value: "C Curl" },
              { name: "Length", value: "8mm" },
            ],
            shipping: {} as TProductVariant["shipping"],
          },
        ],
      }),
    );

    assert.ok(
      normalized.variants?.every((variant) => variant.shipping === undefined),
    );
  });

  it("marks every combination unavailable when the product is unavailable", () => {
    const normalized = normalizeProductVariantModel(
      createTwoAxisProduct({ isAvailable: false }),
    );

    assert.ok(normalized.variants?.every((variant) => !variant.isAvailable));
  });

  it("ignores overrides that do not match a full combination", () => {
    const normalized = normalizeProductVariantModel(
      createTwoAxisProduct({
        variantOverrides: [
          // Missing the Length axis -> not a full combination -> ignored.
          { select: [{ name: "Curl", value: "C Curl" }], price: 99 },
          // Unknown value -> ignored.
          {
            select: [
              { name: "Curl", value: "D Curl" },
              { name: "Length", value: "8mm" },
            ],
            price: 99,
          },
        ],
      }),
    );

    assert.ok(normalized.variants?.every((variant) => variant.price === 22));
  });

  it("keeps derived IDs stable across draft IDs and authored reordering", () => {
    const original = createTwoAxisProduct();
    const reordered = createProduct({
      _id: `drafts.${original._id}`,
      options: [
        { name: "Length", values: ["9mm", "8mm"] },
        { name: "Curl", values: ["C Curl", "CC Curl"] },
      ],
    });

    const originalIds = normalizeProductVariantModel(original)
      .variants?.map((variant) => variant._key)
      .sort();
    const reorderedIds = normalizeProductVariantModel(reordered)
      .variants?.map((variant) => variant._key)
      .sort();

    assert.deepEqual(reorderedIds, originalIds);
  });

  it("keeps non-ASCII derived IDs stable without locale-sensitive sorting", () => {
    const original = createProduct({
      options: [
        { name: "Épaisseur", values: ["Léger", "Épais"] },
        { name: "長さ", values: ["八ミリ", "九ミリ"] },
      ],
    });
    const reordered = createProduct({
      options: [
        { name: "長さ", values: ["九ミリ", "八ミリ"] },
        { name: "Épaisseur", values: ["Épais", "Léger"] },
      ],
    });

    const originalIds = normalizeProductVariantModel(original)
      .variants?.map((variant) => variant._key)
      .sort();
    const reorderedIds = normalizeProductVariantModel(reordered)
      .variants?.map((variant) => variant._key)
      .sort();

    assert.deepEqual(reorderedIds, originalIds);
  });

  it("cleans stega from options and overrides", () => {
    const cleanProduct = createProduct({
      options: [{ name: "Curl", values: ["C"] }],
    });
    // No stega -> options array identity preserved (no needless copy).
    assert.strictEqual(
      normalizeProductVariantModel(cleanProduct).options,
      cleanProduct.options,
    );

    const encoded = (value: string) =>
      vercelStegaCombine(value, { origin: "test" }, false);
    const stegaProduct = createProduct({
      options: [{ name: encoded("Curl"), values: [encoded("C")] }],
    });

    const normalized = normalizeProductVariantModel(stegaProduct);
    assert.equal(normalized.options?.[0]?.name, "Curl");
    assert.deepEqual(normalized.options?.[0]?.values, ["C"]);
    assert.deepEqual(
      normalized.variants?.[0]?.options?.map((option) => ({
        name: option.name,
        value: option.value,
      })),
      [{ name: "Curl", value: "C" }],
    );
  });

  it("resolves a generated combination through the authoritative cart contract", () => {
    const product = normalizeProductVariantModel(createTwoAxisProduct());
    const selected = product.variants?.find(
      (variant) => variant.title === "CC Curl / 8mm",
    );
    assert.ok(selected);

    const cart = buildValidatedCart(
      [{ productId: product._id, variantId: selected._key, quantity: 2 }],
      [
        {
          id: product._id,
          title: product.title,
          price: product.price,
          discountPrice: product.discountPrice,
          currency: product.currency,
          isAvailable: product.isAvailable,
          variants: product.variants?.map((variant) => ({
            id: variant._key,
            title: variant.title,
            price: variant.price,
            discountPrice: variant.discountPrice,
            isAvailable: variant.isAvailable,
          })),
        },
      ],
    );

    assert.equal(cart.lineItems[0]?.variantId, selected._key);
    assert.equal(
      cart.lineItems[0]?.description,
      "Cashmere Flat Lashes — CC Curl / 8mm",
    );
    assert.equal(cart.amount, 44);
  });

  it("rejects an unknown variant ID through cart validation", () => {
    const product = normalizeProductVariantModel(createTwoAxisProduct());

    assert.throws(
      () =>
        buildValidatedCart(
          [
            {
              productId: product._id,
              variantId: "not-a-real-key",
              quantity: 1,
            },
          ],
          [
            {
              id: product._id,
              title: product.title,
              price: product.price,
              currency: product.currency,
              isAvailable: product.isAvailable,
              variants: product.variants?.map((variant) => ({
                id: variant._key,
                title: variant.title,
                price: variant.price,
                isAvailable: variant.isAvailable,
              })),
            },
          ],
        ),
      /Please choose an available product option/,
    );
  });

  const quarantineCases: Array<[string, TProductOption[]]> = [
    [
      "more than two axes",
      [
        { name: "Curl", values: ["C"] },
        { name: "Length", values: ["8mm"] },
        { name: "Finish", values: ["Natural"] },
      ],
    ],
    [
      "duplicate axis names",
      [
        { name: "Curl", values: ["C", "CC"] },
        { name: "curl", values: ["D"] },
      ],
    ],
    ["duplicate values", [{ name: "Curl", values: ["C", "c"] }]],
    ["a blank value", [{ name: "Curl", values: ["C", "   "] }]],
    ["an empty axis", [{ name: "Curl", values: [] }]],
  ];
  for (const [label, options] of quarantineCases) {
    it(`quarantines a product with ${label}`, () => {
      assertQuarantined(
        normalizeProductVariantModel(createProduct({ options })),
      );
    });
  }

  it("caps expansion and fails closed", () => {
    const normalized = normalizeProductVariantModel(
      createProduct({
        options: [
          {
            name: "Curl",
            values: Array.from({ length: 11 }, (_, index) => `C${index}`),
          },
          {
            name: "Length",
            values: Array.from({ length: 10 }, (_, index) => `${index}mm`),
          },
        ],
      }),
    );

    assert.equal(normalized.isAvailable, false);
    assert.equal(
      normalized.availabilityLabel,
      "Option configuration unavailable",
    );
  });
});

function createTwoAxisProduct(overrides: Partial<TProduct> = {}): TProduct {
  return createProduct({
    options: [
      { _key: "curl", name: "Curl", values: ["CC Curl", "C Curl"] },
      { _key: "length", name: "Length", values: ["8mm", "9mm"] },
    ],
    ...overrides,
  });
}

function assertQuarantined(product: TProduct): void {
  assert.equal(product.isAvailable, false);
  assert.equal(product.availabilityLabel, "Option configuration unavailable");
  assert.ok(product.variants?.every((variant) => !variant.isAvailable));
}

function createProduct(overrides: Partial<TProduct> = {}): TProduct {
  return {
    _id: "product-1",
    title: "Cashmere Flat Lashes",
    description: "Test product",
    slug: "cashmere-flat-lashes",
    price: 22,
    currency: "CAD",
    isAvailable: true,
    ...overrides,
  };
}
