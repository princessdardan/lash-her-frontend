import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildValidatedCart, type CatalogProduct } from "./cart";

const product: CatalogProduct = {
  id: "product-1",
  sku: "LASH-CLASSIC",
  title: "Classic Lash Set",
  price: 125,
  currency: "CAD",
  isAvailable: true,
};

describe("commerce cart validation", () => {
  it("builds a validated CAD cart from selected products", () => {
    assert.deepEqual(buildValidatedCart([{ productId: "product-1", quantity: 2 }], [product]), {
      currency: "CAD",
      amount: 250,
      lineItems: [
        {
          productId: "product-1",
          sku: "LASH-CLASSIC",
          description: "Classic Lash Set",
          quantity: 2,
          price: 125,
          total: 250,
        },
      ],
    });
  });

  it("rejects empty carts", () => {
    assert.throws(() => buildValidatedCart([], [product]), /Cart must contain at least one item/);
  });

  it("rejects products that are no longer available", () => {
    assert.throws(
      () => buildValidatedCart([{ productId: "product-2", quantity: 1 }], [product]),
      /Product is no longer available/,
    );

    assert.throws(
      () =>
        buildValidatedCart([{ productId: "product-1", quantity: 1 }], [
          { ...product, isAvailable: false },
        ]),
      /Product is no longer available/,
    );
  });

  it("uses selected variant pricing and SKU when a product has variants", () => {
    assert.deepEqual(
      buildValidatedCart(
        [{ productId: "product-1", variantId: "volume", quantity: 1 }],
        [
          {
            ...product,
            variants: [
              {
                id: "classic",
                sku: "LASH-CLASSIC-SET",
                title: "Classic",
                price: 125,
                isAvailable: true,
              },
              {
                id: "volume",
                sku: "LASH-VOLUME-SET",
                title: "Volume",
                price: 150,
                isAvailable: true,
              },
            ],
          },
        ],
      ),
      {
        currency: "CAD",
        amount: 150,
        lineItems: [
          {
            productId: "product-1",
            variantId: "volume",
            sku: "LASH-VOLUME-SET",
            description: "Classic Lash Set — Volume",
            quantity: 1,
            price: 150,
            total: 150,
          },
        ],
      },
    );
  });

  it("requires an available selected variant for products with variants", () => {
    const productWithVariants: CatalogProduct = {
      ...product,
      variants: [
        {
          id: "classic",
          sku: "LASH-CLASSIC-SET",
          title: "Classic",
          price: 125,
          isAvailable: false,
        },
      ],
    };

    assert.throws(
      () => buildValidatedCart([{ productId: "product-1", quantity: 1 }], [productWithVariants]),
      /Please choose an available product option/,
    );

    assert.throws(
      () => buildValidatedCart([{ productId: "product-1", variantId: "classic", quantity: 1 }], [productWithVariants]),
      /Please choose an available product option/,
    );
  });

  it("rejects quantities outside the checkout bounds", () => {
    assert.throws(
      () => buildValidatedCart([{ productId: "product-1", quantity: 0 }], [product]),
      /Quantity must be between 1 and 10/,
    );

    assert.throws(
      () => buildValidatedCart([{ productId: "product-1", quantity: 11 }], [product]),
      /Quantity must be between 1 and 10/,
    );
  });
});
