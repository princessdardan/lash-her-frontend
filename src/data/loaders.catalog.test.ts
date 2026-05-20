import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const loadersSource = readFileSync(new URL("./loaders.ts", import.meta.url), "utf8");

describe("catalog loader contract", () => {
  it("uses canonical products for public catalog and checkout loaders", () => {
    assert.match(loadersSource, /async function getProducts\(\): Promise<TProduct\[]>/);
    assert.match(loadersSource, /async function getProductsByIds\(ids: string\[\]\): Promise<TProduct\[]>/);
    assert.doesNotMatch(loadersSource, /getLegacyProductCatalogItems/);
    assert.doesNotMatch(loadersSource, /mapSellableProductToProduct/);
  });

  it("projects optional merchant SKUs without exposing generated fallback codes", () => {
    const productProjection = loadersSource.slice(
      loadersSource.indexOf("const PRODUCT_PROJECTION"),
      loadersSource.indexOf("const SERVICE_PROJECTION"),
    );

    assert.match(productProjection, /sku/);
    assert.match(productProjection, /variants\[\]\{ _key, title, sku, price, isAvailable, availabilityLabel \}/);
  });

  it("does not expose legacy sellableProduct loaders from the active data boundary", () => {
    assert.doesNotMatch(loadersSource, /async function getSellableProducts\(/);
    assert.doesNotMatch(loadersSource, /async function getSellableProductsByIds\(/);
    assert.doesNotMatch(loadersSource, /async function getSellableProductBySlug\(/);
    assert.doesNotMatch(loadersSource, /async function getAllSellableProductSlugs\(/);
    assert.doesNotMatch(loadersSource, /getSellableProducts,/);
    assert.doesNotMatch(loadersSource, /getSellableProductsByIds,/);
  });

  it("does not project checkoutProduct for training catalog checkout shapes", () => {
    const trainingProjection = loadersSource.slice(
      loadersSource.indexOf("const TRAINING_PROGRAM_CATALOG_PROJECTION"),
      loadersSource.indexOf("function sanityFetchOptions"),
    );

    assert.doesNotMatch(trainingProjection, /checkoutProduct|sellableProduct/);
  });

  it("derives CAD currency for training catalog checkout shapes", () => {
    const trainingProjection = loadersSource.slice(
      loadersSource.indexOf("const TRAINING_PROGRAM_CATALOG_PROJECTION"),
      loadersSource.indexOf("function sanityFetchOptions"),
    );

    assert.match(trainingProjection, /"currency": "CAD"/);
    assert.doesNotMatch(trainingProjection, /^\s*currency,\s*$/m);
  });
});
