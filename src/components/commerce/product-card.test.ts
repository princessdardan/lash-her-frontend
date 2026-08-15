import { describe, it } from "node:test";
import assert from "node:assert";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { normalizeProductVariantModel } from "@/lib/commerce/product-variant-model";
import type { TProduct } from "@/types";

const router: AppRouterInstance = {
  back: () => {},
  bfcacheId: "test-bfcache",
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
};

describe("ProductCard", () => {
  it("renders availability label, fulfillment note, variant option title, price, and unavailable label", async () => {
    process.env.NEXT_PUBLIC_SANITY_DATASET = "test-dataset";
    process.env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

    const { ProductCard } = await import("./product-card");

    const product: TProduct = {
      _id: "prod-1",
      title: "Test Product",
      description: "Test Description",
      slug: "test-product",
      price: 100,
      currency: "CAD",
      isAvailable: true,
      availabilityLabel: "In Stock",
      shipping: {
        fulfillmentMode: "physical",
        weightGrams: 35,
        packingUnits: 1,
        customsDescription: "Synthetic eyelash extensions",
        countryOfOrigin: "KR",
      },
      fulfillmentNote: "Ships in 2 days",
      variants: [
        {
          _key: "var-1",
          title: "Variant 1",
          price: 120,
          isAvailable: true,
        },
        {
          _key: "var-2",
          title: "Variant 2",
          price: 150,
          isAvailable: false,
          availabilityLabel: "Out of Stock",
        },
      ],
    };

    const html = renderProductCardToStaticMarkup(
      React.createElement(ProductCard, {
        product,
        onAdd: () => {},
      }),
    );

    assert.ok(html.includes("In Stock"), "Missing availability label");
    assert.ok(html.includes("Ships in 2 days"), "Missing fulfillment note");
    assert.ok(html.includes("Variant 1"), "Missing variant 1 title");
    assert.ok(html.includes("Variant 2"), "Missing variant 2 title");
    assert.ok(html.includes("$120.00"), "Missing variant 1 price");
    assert.ok(html.includes("$150.00"), "Missing variant 2 price");
    assert.ok(html.includes("Out of Stock"), "Missing unavailable label");
  });

  it("renders catalog buy-now actions with a Next app router context", async () => {
    process.env.NEXT_PUBLIC_SANITY_DATASET = "test-dataset";
    process.env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

    const { ProductCard } = await import("./product-card");

    const product: TProduct = {
      _id: "prod-1",
      title: "Test Product",
      description: "Test Description",
      slug: "test-product",
      price: 100,
      currency: "CAD",
      isAvailable: true,
      availabilityLabel: "In Stock",
      shipping: {
        fulfillmentMode: "physical",
        weightGrams: 35,
        packingUnits: 1,
        customsDescription: "Synthetic eyelash extensions",
        countryOfOrigin: "KR",
      },
    };

    const html = renderProductCardToStaticMarkup(
      React.createElement(ProductCard, { product }),
    );

    assert.ok(html.includes("View Details"), "Missing product detail action");
    assert.ok(html.includes("Buy Now"), "Missing buy-now action");
    assert.ok(
      html.includes('aria-label="Buy now: Test Product"'),
      "Missing buy-now accessible label",
    );
  });

  it("renders every grouped nested option as a concrete catalog dropdown choice", async () => {
    process.env.NEXT_PUBLIC_SANITY_DATASET = "test-dataset";
    process.env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

    const { ProductCard } = await import("./product-card");
    const product = normalizeProductVariantModel({
      _id: "prod-grouped",
      title: "Cashmere Flat Lashes",
      description: "Test Description",
      slug: "cashmere-flat-lashes",
      price: 22,
      currency: "CAD",
      isAvailable: true,
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

    const html = renderProductCardToStaticMarkup(
      React.createElement(ProductCard, { product }),
    );

    for (const label of [
      "CC Curl / 8mm",
      "CC Curl / 9mm",
      "C Curl / 8mm",
      "C Curl / 9mm",
    ]) {
      assert.ok(
        html.includes(label),
        `Missing grouped dropdown choice: ${label}`,
      );
    }
  });
});

function renderProductCardToStaticMarkup(element: React.ReactElement): string {
  return renderToStaticMarkup(
    React.createElement(AppRouterContext.Provider, { value: router }, element),
  );
}
