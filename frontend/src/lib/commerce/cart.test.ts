import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildValidatedCart, type CommerceProduct } from "./cart";

const product: CommerceProduct = {
  available: true,
  description: "Classic lash refill",
  id: "product-1",
  price: 125,
  sku: "LASH-REFILL",
};

describe("commerce cart validation", () => {
  it("builds a validated CAD cart from selected products", () => {
    assert.deepEqual(buildValidatedCart([{ productId: "product-1", quantity: 2 }], [product]), {
      amount: 250,
      currency: "CAD",
      items: [
        {
          description: "Classic lash refill",
          price: 125,
          quantity: 2,
          sku: "LASH-REFILL",
          total: 250,
        },
      ],
    });
  });

  it("rejects products that are no longer available", () => {
    assert.throws(
      () => buildValidatedCart([{ productId: "product-2", quantity: 1 }], [product]),
      /Product is no longer available/,
    );

    assert.throws(
      () =>
        buildValidatedCart([{ productId: "product-1", quantity: 1 }], [
          { ...product, available: false },
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
