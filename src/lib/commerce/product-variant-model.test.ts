import assert from "node:assert";
import { describe, it } from "node:test";
import { vercelStegaCombine } from "@vercel/stega";

import type { TProduct, TProductVariant } from "@/types";
import { buildValidatedCart } from "./cart";
import { normalizeProductVariantModel } from "./product-variant-model";

describe("normalizeProductVariantModel", () => {
  it("returns canonical concrete variants unchanged", () => {
    const product = createProduct({
      optionGroups: [
        { _key: "curl", name: "Curl", values: ["C", "CC"] },
        { _key: "length", name: "Length", values: ["8mm", "9mm"] },
      ],
      variants: [
        concreteVariant("c-8", "C / 8mm", "C", "8mm"),
        concreteVariant("cc-9", "CC / 9mm", "CC", "9mm"),
      ],
    });

    assert.strictEqual(normalizeProductVariantModel(product), product);
  });

  it("keeps title-only canonical variants without option groups unchanged", () => {
    const product = createProduct({
      variants: [
        {
          _key: "single",
          title: "Standard",
          price: 22,
          isAvailable: true,
        },
      ],
    });

    assert.strictEqual(normalizeProductVariantModel(product), product);
  });

  it("quarantines an incomplete canonical option row", () => {
    const product = createProduct({
      optionGroups: [
        { _key: "curl", name: "Curl", values: ["C", "CC"] },
        { _key: "length", name: "Length", values: ["8mm", "9mm"] },
      ],
      variants: [
        concreteVariant("c-8", "C / 8mm", "C", "8mm"),
        {
          ...concreteVariant("cc-9", "CC / 9mm", "CC", "9mm"),
          options: [
            { _key: "cc-9-curl", name: "Curl", value: "CC" },
            { _key: "cc-9-length", name: "Length" },
          ],
        },
      ],
    });

    const normalized = normalizeProductVariantModel(product);
    assertQuarantined(normalized);
    assert.equal(normalized.variants?.length, 2);
    assert.equal(normalized.variants?.[1]?._key, "cc-9");
  });

  it("expands grouped choices into deterministic concrete combinations", () => {
    const normalized = normalizeProductVariantModel(createGroupedProduct());

    assert.deepEqual(
      normalized.optionGroups?.map((group) => ({
        name: group.name,
        values: group.values,
      })),
      [
        { name: "Curl", values: ["CC Curl", "C Curl"] },
        { name: "Length", values: ["8mm", "9mm"] },
      ],
    );
    assert.deepEqual(
      normalized.variants?.map((variant) => variant.title),
      ["CC Curl / 8mm", "CC Curl / 9mm", "C Curl / 8mm", "C Curl / 9mm"],
    );
    assert.equal(normalized.variants?.length, 4);

    for (const variant of normalized.variants ?? []) {
      assert.match(variant._key, /^derived_v1_[a-f0-9]{32}$/);
      assert.ok(variant._key.length <= 128);
      assert.equal(variant.price, 22);
      assert.equal(variant.isAvailable, true);
      assert.deepEqual(
        variant.options?.map((option) => option.name),
        ["Curl", "Length"],
      );
    }
  });

  it("handles the production draft shape with explicit and missing option values", () => {
    const normalized = normalizeProductVariantModel(
      createProduct({
        optionGroups: [
          { _key: "curl-order", name: "Curl", values: ["C", "CC"] },
          { _key: "length-order", name: "Length", values: ["17mm", "12mm"] },
        ],
        variants: [
          {
            _key: "length-group",
            title: "Length",
            price: 17,
            isAvailable: true,
            options: [
              { _key: "mixed", name: "Mixed 7-14mm" },
              { _key: "8mm", name: "8mm" },
              { _key: "9mm", name: "9mm" },
              { _key: "10mm", name: "10mm" },
              { _key: "11mm", name: "11mm" },
              { _key: "12mm", name: "12mm" },
              { _key: "13mm", name: "13mm" },
              { _key: "14mm", name: "14mm" },
            ],
          },
          {
            _key: "curl-group",
            title: "Curl",
            price: 17,
            isAvailable: true,
            options: [
              { _key: "c", name: "C", value: "C" },
              { _key: "cc", name: "CC", value: "CC" },
            ],
          },
        ],
        price: 17,
      }),
    );

    assert.deepEqual(
      normalized.optionGroups?.map((group) => group.name),
      ["Curl", "Length"],
    );
    assert.deepEqual(normalized.optionGroups?.[1]?.values, [
      "Mixed 7-14mm",
      "8mm",
      "9mm",
      "10mm",
      "11mm",
      "12mm",
      "13mm",
      "14mm",
    ]);
    assert.equal(normalized.variants?.length, 16);
    assert.equal(normalized.variants?.[0]?.title, "C / Mixed 7-14mm");
    assert.equal(normalized.variants?.[7]?.title, "C / 14mm");
    assert.equal(normalized.variants?.[8]?.title, "CC / Mixed 7-14mm");
    assert.equal(normalized.variants?.[15]?.title, "CC / 14mm");
  });

  it("expands declared one-choice grouped rows", () => {
    const normalized = normalizeProductVariantModel(
      createProduct({
        optionGroups: [
          { _key: "curl", name: "Curl", values: ["C"] },
          { _key: "length", name: "Length", values: ["8mm"] },
        ],
        variants: [
          groupedVariant("curl-group", "Curl", ["C"]),
          groupedVariant("length-group", "Length", ["8mm"]),
        ],
      }),
    );

    assert.equal(normalized.variants?.length, 1);
    assert.match(normalized.variants?.[0]?._key ?? "", /^derived_v1_/);
    assert.equal(normalized.variants?.[0]?.title, "C / 8mm");
  });

  it("expands one declared parent with multiple choices", () => {
    const normalized = normalizeProductVariantModel(
      createProduct({
        optionGroups: [{ _key: "curl", name: "Curl", values: ["C", "CC"] }],
        variants: [groupedVariant("curl-group", "Curl", ["C", "CC"])],
      }),
    );

    assert.deepEqual(
      normalized.variants?.map((variant) => variant.title),
      ["C", "CC"],
    );
    assert.ok(
      normalized.variants?.every((variant) =>
        variant._key.startsWith("derived_v1_"),
      ),
    );
  });

  it("honors the explicit grouped and concrete discriminators", () => {
    const grouped = createProduct({
      variantModel: "grouped",
      variants: [groupedVariant("curl-group", "Curl", ["C", "CC"])],
    });
    const concrete = createProduct({
      ...grouped,
      variantModel: "concrete",
    });

    const normalizedGrouped = normalizeProductVariantModel(grouped);
    assert.equal(normalizedGrouped.variants?.length, 2);
    assert.ok(
      normalizedGrouped.variants?.every((variant) =>
        variant._key.startsWith("derived_v1_"),
      ),
    );
    assertQuarantined(normalizeProductVariantModel(concrete));
  });

  it("cleans a stega-encoded grouped discriminator before classification", () => {
    const normalized = normalizeProductVariantModel(
      createProduct({
        variantModel: vercelStegaCombine(
          "grouped",
          { origin: "test" },
          false,
        ) as TProduct["variantModel"],
        variants: [groupedVariant("curl-group", "Curl", ["C"])],
      }),
    );

    assert.equal(normalized.variantModel, "grouped");
    assert.equal(normalized.variants?.length, 1);
    assert.match(normalized.variants?.[0]?._key ?? "", /^derived_v1_/);
  });

  it("allows repeated choice labels for explicitly grouped variants", () => {
    const normalized = normalizeProductVariantModel(
      createProduct({
        variantModel: "grouped",
        variants: [
          groupedVariant("finish", "Finish", ["Natural", "Bold"]),
          groupedVariant("density", "Density", ["Natural", "Full"]),
        ],
      }),
    );

    assert.equal(normalized.variants?.length, 4);
    assert.equal(normalized.variants?.[0]?.title, "Natural / Natural");
  });

  it("allows repeated choice labels for exact declared legacy groups", () => {
    const normalized = normalizeProductVariantModel(
      createProduct({
        optionGroups: [
          { name: "Finish", values: ["Natural", "Bold"] },
          { name: "Density", values: ["Natural", "Full"] },
        ],
        variants: [
          groupedVariant("finish", "Finish", ["Natural", "Bold"]),
          groupedVariant("density", "Density", ["Natural", "Full"]),
        ],
      }),
    );

    assert.equal(normalized.variants?.length, 4);
    assert.equal(normalized.variants?.[0]?.title, "Natural / Natural");
  });

  for (const [label, variants] of [
    [
      "duplicate groups",
      [
        groupedVariant("curl-a", "Curl", ["C", "CC"]),
        groupedVariant("curl-b", "curl", ["D", "DD"]),
      ],
    ],
    [
      "duplicate choices",
      [
        groupedVariant("curl", "Curl", ["C", "c"]),
        groupedVariant("length", "Length", ["8mm", "9mm"]),
      ],
    ],
    [
      "overlapping choices",
      [
        groupedVariant("curl", "Curl", ["C", "CC"]),
        groupedVariant("style", "Style", ["C", "D"]),
      ],
    ],
  ] as const) {
    it(`quarantines grouped data with ${label}`, () => {
      assertQuarantined(
        normalizeProductVariantModel(
          createProduct({
            variants: variants.map((variant) => ({ ...variant })),
          }),
        ),
      );
    });
  }

  it("quarantines mixed missing and self-valued choices within a group", () => {
    const product = createGroupedProduct();
    product.variants![0] = {
      ...product.variants![0],
      options: [
        { _key: "cc", name: "CC Curl" },
        { _key: "c", name: "C Curl", value: "C Curl" },
      ],
    };

    assertQuarantined(normalizeProductVariantModel(product));
  });

  it("rejects raw group IDs through cart validation", () => {
    const normalized = normalizeProductVariantModel(createGroupedProduct());
    assert.equal(normalized.isAvailable, true);

    assert.throws(
      () =>
        buildValidatedCart(
          [
            {
              productId: normalized._id,
              variantId: "curl-group",
              quantity: 1,
            },
          ],
          [
            {
              id: normalized._id,
              title: normalized.title,
              price: normalized.price,
              currency: normalized.currency,
              isAvailable: normalized.isAvailable,
              variants: normalized.variants?.map((variant) => ({
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

  it("keeps synthetic IDs stable across draft IDs and authored reordering", () => {
    const original = createGroupedProduct();
    const reordered: TProduct = {
      ...createGroupedProduct(),
      _id: `drafts.${original._id}`,
      variants: [...(original.variants ?? [])].reverse().map((variant) => ({
        ...variant,
        options: [...(variant.options ?? [])].reverse(),
      })),
    };

    const originalIds = normalizeProductVariantModel(original)
      .variants?.map((variant) => variant._key)
      .sort();
    const reorderedIds = normalizeProductVariantModel(reordered)
      .variants?.map((variant) => variant._key)
      .sort();

    assert.deepEqual(reorderedIds, originalIds);
  });

  it("keeps non-ASCII synthetic IDs stable without locale-sensitive sorting", () => {
    const original = createProduct({
      variantModel: "grouped",
      variants: [
        groupedVariant("thickness", "Épaisseur", ["Léger", "Épais"]),
        groupedVariant("length", "長さ", ["八ミリ", "九ミリ"]),
      ],
    });
    const reordered: TProduct = {
      ...original,
      variants: [...(original.variants ?? [])].reverse().map((variant) => ({
        ...variant,
        options: [...(variant.options ?? [])].reverse(),
      })),
    };

    const originalIds = normalizeProductVariantModel(original)
      .variants?.map((variant) => variant._key)
      .sort();
    const reorderedIds = normalizeProductVariantModel(reordered)
      .variants?.map((variant) => variant._key)
      .sort();

    assert.deepEqual(reorderedIds, originalIds);
  });

  it("cleans stega from option paths and preserves already-clean references", () => {
    const cleanProduct = createProduct({
      optionGroups: [{ name: "Curl", values: ["C"] }],
      variants: [
        {
          _key: "c",
          title: "C",
          price: 22,
          isAvailable: true,
          options: [{ name: "Curl", value: "C" }],
        },
      ],
    });
    assert.strictEqual(
      normalizeProductVariantModel(cleanProduct),
      cleanProduct,
    );

    const encoded = (value: string) =>
      vercelStegaCombine(value, { origin: "test" }, false);
    const stegaProduct: TProduct = {
      ...cleanProduct,
      optionGroups: [{ name: encoded("Curl"), values: [encoded("C")] }],
      variants: [
        {
          ...cleanProduct.variants![0],
          options: [{ name: encoded("Curl"), value: encoded("C") }],
        },
      ],
    };

    const normalized = normalizeProductVariantModel(stegaProduct);
    assert.notStrictEqual(normalized, stegaProduct);
    assert.equal(normalized.optionGroups?.[0]?.name, "Curl");
    assert.deepEqual(normalized.optionGroups?.[0]?.values, ["C"]);
    assert.deepEqual(normalized.variants?.[0]?.options, [
      { name: "Curl", value: "C" },
    ]);
  });

  it("resolves a generated combination through the existing authoritative cart contract", () => {
    const product = normalizeProductVariantModel(createGroupedProduct());
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

  it("marks derived combinations unavailable when any required group is unavailable", () => {
    const product = createGroupedProduct();
    product.variants![1] = {
      ...product.variants![1],
      isAvailable: false,
      availabilityLabel: "Sold out",
    };

    const normalized = normalizeProductVariantModel(product);
    assert.ok(normalized.variants?.every((variant) => !variant.isAvailable));
  });

  it("treats empty variant shipping objects as no override", () => {
    const product = createGroupedProduct();
    product.shipping = {
      fulfillmentMode: "physical",
      weightGrams: 25,
    };
    product.variants![0] = {
      ...product.variants![0],
      shipping: {} as TProductVariant["shipping"],
    };
    product.variants![1] = {
      ...product.variants![1],
      shipping: {
        _type: "productShipping",
        customsDescription: "",
      } as unknown as TProductVariant["shipping"],
    };

    const normalized = normalizeProductVariantModel(product);
    assert.equal(normalized.isAvailable, true);
    assert.strictEqual(normalized.shipping, product.shipping);
    assert.ok(
      normalized.variants?.every((variant) => variant.shipping === undefined),
    );
  });

  for (const [label, mutate] of [
    [
      "conflicting prices",
      (product: TProduct) => {
        product.variants![1] = { ...product.variants![1], price: 24 };
      },
    ],
    [
      "container SKUs",
      (product: TProduct) => {
        product.variants![0] = { ...product.variants![0], sku: "GROUP-SKU" };
      },
    ],
    [
      "conflicting shipping overrides",
      (product: TProduct) => {
        product.variants![0] = {
          ...product.variants![0],
          shipping: { fulfillmentMode: "physical", weightGrams: 10 },
        };
        product.variants![1] = {
          ...product.variants![1],
          shipping: { fulfillmentMode: "physical", weightGrams: 20 },
        };
      },
    ],
    [
      "conflicting discounts",
      (product: TProduct) => {
        product.variants![0] = {
          ...product.variants![0],
          discountPrice: 18,
        };
        product.variants![1] = {
          ...product.variants![1],
          discountPrice: 19,
        };
      },
    ],
    [
      "an invalid-cent price",
      (product: TProduct) => {
        product.variants![0] = {
          ...product.variants![0],
          price: 22.001,
        };
      },
    ],
  ] as const) {
    it(`fails closed for grouped choices with ${label}`, () => {
      const product = createGroupedProduct();
      mutate(product);

      const normalized = normalizeProductVariantModel(product);
      assert.equal(normalized.isAvailable, false);
      assert.equal(
        normalized.availabilityLabel,
        "Option configuration unavailable",
      );
      assert.ok(normalized.variants?.every((variant) => !variant.isAvailable));
    });
  }

  it("caps grouped expansion and fails closed", () => {
    const choices = Array.from({ length: 11 }, (_, index) => ({
      _key: `choice-${index}`,
      name: `Choice ${index}`,
    }));
    const product = createProduct({
      variants: [
        {
          _key: "a",
          title: "A",
          price: 22,
          isAvailable: true,
          options: choices,
        },
        {
          _key: "b",
          title: "B",
          price: 22,
          isAvailable: true,
          options: choices.map((option) => ({
            ...option,
            _key: `b-${option._key}`,
            name: `B ${option.name}`,
          })),
        },
      ],
    });

    const normalized = normalizeProductVariantModel(product);
    assert.equal(normalized.isAvailable, false);
    assert.equal(normalized.variants?.length, 2);
    assert.ok(normalized.variants?.every((variant) => !variant.isAvailable));
  });
});

function createGroupedProduct(): TProduct {
  return createProduct({
    variants: [
      {
        _key: "curl-group",
        title: "Curl",
        price: 22,
        isAvailable: true,
        options: [
          { _key: "cc-curl", name: "CC Curl", value: null },
          { _key: "c-curl", name: "C Curl", value: null },
        ],
      },
      {
        _key: "length-group",
        title: "Length",
        price: 22,
        isAvailable: true,
        options: [
          { _key: "8mm", name: "8mm", value: null },
          { _key: "9mm", name: "9mm", value: null },
        ],
      },
    ],
  });
}

function concreteVariant(
  key: string,
  title: string,
  curl: string,
  length: string,
): TProductVariant {
  return {
    _key: key,
    title,
    price: 22,
    isAvailable: true,
    options: [
      { _key: `${key}-curl`, name: "Curl", value: curl },
      { _key: `${key}-length`, name: "Length", value: length },
    ],
  };
}

function groupedVariant(
  key: string,
  title: string,
  choices: readonly string[],
): TProductVariant {
  return {
    _key: key,
    title,
    price: 22,
    isAvailable: true,
    options: choices.map((choice, index) => ({
      _key: `${key}-${index}`,
      name: choice,
      value: null,
    })),
  };
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
