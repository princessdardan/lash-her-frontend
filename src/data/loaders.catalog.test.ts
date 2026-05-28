import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const loadersSource = readFileSync(new URL("./loaders.ts", import.meta.url), "utf8");

describe("catalog loader contract", () => {
  it("uses canonical products for public catalog and checkout loaders", () => {
    assert.match(loadersSource, /async function getProducts\(sort: ProductSort = "default"\): Promise<TProduct\[]>/);
    assert.match(loadersSource, /async function getProductsByIds\(ids: string\[\]\): Promise<TProduct\[]>/);
    assert.match(loadersSource, /async function getProductBySlug\(slug: string\): Promise<TProduct \| null>/);
    assert.match(loadersSource, /async function getAllProductSlugs\(\): Promise<Array<\{ slug: string \}>>/);
    assert.doesNotMatch(loadersSource, /getLegacyProductCatalogItems/);
    assert.doesNotMatch(loadersSource, /legacyProductCatalog/);
    assert.doesNotMatch(loadersSource, /getProductFilterAttributes|ProductFilters|filterAttributes/);
  });

  it("projects optional merchant SKUs without exposing generated fallback codes", () => {
    const productProjection = loadersSource.slice(
      loadersSource.indexOf("const PRODUCT_PROJECTION"),
      loadersSource.indexOf("const SERVICE_PROJECTION"),
    );

    assert.match(productProjection, /sku/);
    assert.match(
      productProjection,
      /variants\[\]\{ _key, title, sku, price, discountPrice, isAvailable, availabilityLabel, options\[\]\{ _key, name, value \} \}/,
    );
  });

  it("projects only native training checkout fields for training checkout shapes", () => {
    const trainingProjection = loadersSource.slice(
      loadersSource.indexOf("const TRAINING_PROGRAM_CATALOG_PROJECTION"),
      loadersSource.indexOf("function sanityFetchOptions"),
    );

    assert.doesNotMatch(trainingProjection, /legacyProductCatalog/);
    assert.doesNotMatch(trainingProjection, /->/);
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
