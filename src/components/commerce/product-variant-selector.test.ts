import assert from "node:assert";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { normalizeProductVariantModel } from "@/lib/commerce/product-variant-model";
import type { TProduct } from "@/types";
import { ProductVariantSelector } from "./product-variant-selector";

describe("ProductVariantSelector", () => {
  it("renders option axes as selectable option groups on product detail pages", () => {
    const product = normalizeProductVariantModel(createTwoAxisProduct());
    const html = renderToStaticMarkup(
      React.createElement(ProductVariantSelector, { product }),
    );

    assert.ok(html.includes("Available Options"));
    assert.ok(html.includes('aria-label="Curl options"'));
    assert.ok(html.includes('aria-label="Length options"'));

    for (const label of [
      "Curl: CC Curl",
      "Curl: C Curl",
      "Length: 8mm",
      "Length: 9mm",
    ]) {
      assert.ok(
        html.includes(`aria-label="${label}"`),
        `Missing detail option: ${label}`,
      );
    }
  });
});

function createTwoAxisProduct(): TProduct {
  return {
    _id: "prod-grouped",
    title: "Cashmere Flat Lashes",
    description: "Test Description",
    slug: "cashmere-flat-lashes",
    price: 22,
    currency: "CAD",
    isAvailable: true,
    options: [
      { _key: "curl", name: "Curl", values: ["CC Curl", "C Curl"] },
      { _key: "length", name: "Length", values: ["8mm", "9mm"] },
    ],
  };
}
