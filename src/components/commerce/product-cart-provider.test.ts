import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PRODUCT_CART_STORAGE_KEY,
  createBuyNowPayload,
  loadProductCartItems,
  persistProductCartItems,
  productCartReducer,
  type ProductCartState,
} from "./product-cart-provider";

class MemoryStorage {
  private readonly entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }
}

const throwingStorage = {
  getItem(): string | null {
    throw new Error("Storage unavailable");
  },
  setItem(): void {
    throw new Error("Storage unavailable");
  },
  removeItem(): void {
    throw new Error("Storage unavailable");
  },
};

const emptyState: ProductCartState = {
  items: [],
  isOpen: false,
};

describe("product cart provider helpers", () => {
  it("adds items, merges duplicate product variants, and clamps merged quantities to 10", () => {
    const first = productCartReducer(emptyState, {
      type: "addItem",
      item: { productId: "product-1", variantId: "classic", quantity: 4 },
    });

    const merged = productCartReducer(first, {
      type: "addItem",
      item: { productId: "product-1", variantId: "classic", quantity: 9 },
    });

    const withDifferentVariant = productCartReducer(merged, {
      type: "addItem",
      item: { productId: "product-1", variantId: "volume", quantity: 1 },
    });

    assert.deepEqual(withDifferentVariant.items, [
      { productId: "product-1", variantId: "classic", quantity: 10 },
      { productId: "product-1", variantId: "volume", quantity: 1 },
    ]);
  });

  it("removes a matching product/variant line item", () => {
    const state: ProductCartState = {
      items: [
        { productId: "product-1", variantId: "classic", quantity: 1 },
        { productId: "product-1", variantId: "volume", quantity: 1 },
      ],
      isOpen: true,
    };

    assert.deepEqual(
      productCartReducer(state, {
        type: "removeItem",
        productId: "product-1",
        variantId: "classic",
      }),
      {
        items: [{ productId: "product-1", variantId: "volume", quantity: 1 }],
        isOpen: true,
      },
    );
  });

  it("updates quantities within cart bounds", () => {
    const state: ProductCartState = {
      items: [{ productId: "product-1", quantity: 2 }],
      isOpen: false,
    };

    assert.deepEqual(
      productCartReducer(state, {
        type: "updateQuantity",
        productId: "product-1",
        quantity: 14,
      }).items,
      [{ productId: "product-1", quantity: 10 }],
    );

    assert.deepEqual(
      productCartReducer(state, {
        type: "updateQuantity",
        productId: "product-1",
        quantity: 0,
      }).items,
      [{ productId: "product-1", quantity: 1 }],
    );
  });

  it("clears cart items without changing drawer state", () => {
    const state: ProductCartState = {
      items: [{ productId: "product-1", quantity: 2 }],
      isOpen: true,
    };

    assert.deepEqual(productCartReducer(state, { type: "clearCart" }), {
      items: [],
      isOpen: true,
    });
  });

  it("loads persisted cart items from storage", () => {
    const storage = new MemoryStorage();
    persistProductCartItems(
      [
        { productId: "product-1", quantity: 2 },
        { productId: "product-2", variantId: "volume", quantity: 1 },
      ],
      storage,
    );

    assert.deepEqual(loadProductCartItems(storage), [
      { productId: "product-1", quantity: 2 },
      { productId: "product-2", variantId: "volume", quantity: 1 },
    ]);
  });

  it("resets malformed storage to an empty cart without throwing", () => {
    const storage = new MemoryStorage();
    storage.setItem(PRODUCT_CART_STORAGE_KEY, "{not valid json");

    assert.deepEqual(loadProductCartItems(storage), []);
    assert.equal(storage.getItem(PRODUCT_CART_STORAGE_KEY), "[]");
  });

  it("falls back to an empty cart when storage access throws", () => {
    assert.deepEqual(loadProductCartItems(throwingStorage), []);
    assert.doesNotThrow(() => {
      persistProductCartItems([{ productId: "product-1", quantity: 1 }], throwingStorage);
    });
  });

  it("creates isolated Buy Now payloads without mutating stored cart state", () => {
    const state: ProductCartState = {
      items: [{ productId: "product-1", quantity: 2 }],
      isOpen: false,
    };

    const payload = createBuyNowPayload({
      productId: "product-2",
      variantId: "classic",
      quantity: 12,
    });

    payload[0].quantity = 3;

    assert.deepEqual(state.items, [{ productId: "product-1", quantity: 2 }]);
    assert.deepEqual(createBuyNowPayload({ productId: "product-2", variantId: "classic", quantity: 12 }), [
      { productId: "product-2", variantId: "classic", quantity: 10 },
    ]);
  });
});
