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

  it("applies manual product discounts before checkout totals", () => {
    assert.deepEqual(
      buildValidatedCart([{ productId: "product-1", quantity: 2 }], [{ ...product, discountPrice: 100 }]),
      {
        currency: "CAD",
        amount: 200,
        originalAmount: 250,
        manualDiscountAmount: 50,
        lineItems: [
          {
            productId: "product-1",
            sku: "LASH-CLASSIC",
            description: "Classic Lash Set",
            quantity: 2,
            price: 100,
            originalPrice: 125,
            manualDiscount: 25,
            total: 200,
            originalTotal: 250,
          },
        ],
      },
    );
  });

  it("applies promotion codes after manual discounts", () => {
    assert.deepEqual(
      buildValidatedCart(
        [{ productId: "product-1", quantity: 2 }],
        [{ ...product, discountPrice: 100 }],
        {
          promotionCode: {
            _id: "promo-save10",
            code: "SAVE10",
            isEnabled: true,
            discountType: "percentage",
            amount: 10,
            appliesTo: "products",
          },
        },
      ),
      {
        currency: "CAD",
        amount: 180,
        amountBeforePromotion: 200,
        originalAmount: 250,
        manualDiscountAmount: 50,
        promotionCode: "SAVE10",
        promotionDiscountAmount: 20,
        lineItems: [
          {
            productId: "product-1",
            sku: "LASH-CLASSIC",
            description: "Classic Lash Set",
            quantity: 2,
            price: 100,
            originalPrice: 125,
            manualDiscount: 25,
            total: 200,
            originalTotal: 250,
          },
        ],
      },
    );
  });

  it("applies specific product promotion codes only to eligible cart lines", () => {
    assert.deepEqual(
      buildValidatedCart(
        [
          { productId: "product-1", quantity: 1 },
          { productId: "product-2", quantity: 1 },
        ],
        [
          product,
          {
            id: "product-2",
            title: "Volume Lash Set",
            price: 200,
            currency: "CAD",
            isAvailable: true,
          },
        ],
        {
          promotionCode: {
            _id: "promo-specific",
            code: "CLASSIC20",
            isEnabled: true,
            discountType: "percentage",
            amount: 20,
            appliesTo: "specificItems",
            products: [{ _id: "product-1" }],
          },
        },
      ),
      {
        currency: "CAD",
        amount: 300,
        amountBeforePromotion: 325,
        originalAmount: 325,
        promotionCode: "CLASSIC20",
        promotionDiscountAmount: 25,
        lineItems: [
          {
            productId: "product-1",
            sku: "LASH-CLASSIC",
            description: "Classic Lash Set",
            quantity: 1,
            price: 125,
            total: 125,
          },
          {
            productId: "product-2",
            sku: "product-2",
            description: "Volume Lash Set",
            quantity: 1,
            price: 200,
            total: 200,
          },
        ],
      },
    );
  });

  it("ignores promotion codes that do not apply to products", () => {
    assert.deepEqual(
      buildValidatedCart(
        [{ productId: "product-1", quantity: 1 }],
        [product],
        {
          promotionCode: {
            _id: "promo-training",
            code: "TRAINING10",
            isEnabled: true,
            discountType: "percentage",
            amount: 10,
            appliesTo: "trainingPrograms",
          },
        },
      ),
      {
        currency: "CAD",
        amount: 125,
        lineItems: [
          {
            productId: "product-1",
            sku: "LASH-CLASSIC",
            description: "Classic Lash Set",
            quantity: 1,
            price: 125,
            total: 125,
          },
        ],
      },
    );
  });

  it("derives stable line item codes from IDs when products or variants have no SKU", () => {
    assert.deepEqual(
      buildValidatedCart(
        [{ productId: "product-sku-less", variantId: "volume", quantity: 1 }],
        [
          {
            id: "product-sku-less",
            title: "SKU-less Lash Kit",
            price: 95,
            currency: "CAD",
            isAvailable: true,
            variants: [
              {
                id: "volume",
                title: "Volume Kit",
                price: 125,
                isAvailable: true,
              },
            ],
          },
        ],
      ),
      {
        currency: "CAD",
        amount: 125,
        lineItems: [
          {
            productId: "product-sku-less",
            variantId: "volume",
            sku: "product-sku-less:volume",
            description: "SKU-less Lash Kit — Volume Kit",
            quantity: 1,
            price: 125,
            total: 125,
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
