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
    assert.match(
      productProjection,
      /variants\[\]\{ _key, title, sku, price, isAvailable, availabilityLabel, options\[\]\{ _key, name, value \} \}/,
    );
  });

  it("exposes sellableProduct editorial loaders from the active data boundary", () => {
    assert.match(loadersSource, /async function getSellableProducts\(filters: SellableProductFilters = \{\}\): Promise<TSellableProduct\[]>/);
    assert.match(loadersSource, /async function getSellableProductsByIds\(ids: string\[\]\): Promise<TSellableProduct\[]>/);
    assert.match(loadersSource, /async function getSellableProductBySlug\(slug: string\): Promise<TSellableProduct \| null>/);
    assert.match(loadersSource, /async function getAllSellableProductSlugs\(\): Promise<Array<\{ slug: string \}>>/);
    assert.match(loadersSource, /^\s{2}getSellableProducts,$/m);
    assert.match(loadersSource, /^\s{2}getSellableProductsByIds,$/m);
    assert.match(loadersSource, /^\s{2}getSellableProductBySlug,$/m);
    assert.match(loadersSource, /^\s{2}getAllSellableProductSlugs,$/m);
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
