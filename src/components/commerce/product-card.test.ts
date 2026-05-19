import { describe, it } from "node:test";
import assert from "node:assert";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TProduct } from "@/types";

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

    const html = renderToStaticMarkup(
      React.createElement(ProductCard, {
        product,
        onAdd: () => {},
      })
    );

    assert.ok(html.includes("In Stock"), "Missing availability label");
    assert.ok(html.includes("Ships in 2 days"), "Missing fulfillment note");
    assert.ok(html.includes("Variant 1"), "Missing variant 1 title");
    assert.ok(html.includes("Variant 2"), "Missing variant 2 title");
    assert.ok(html.includes("$120.00"), "Missing variant 1 price");
    assert.ok(html.includes("$150.00"), "Missing variant 2 price");
    assert.ok(html.includes("Out of Stock"), "Missing unavailable label");
  });
});
