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
