import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const loadersSource = readFileSync(new URL("./loaders.ts", import.meta.url), "utf8");

describe("catalog loader contract", () => {
  it("uses canonical products for public catalog and checkout loaders", () => {
    assert.match(loadersSource, /async function getProducts\(filters: ProductFilters = \{\}\): Promise<TProduct\[]>/);
    assert.match(loadersSource, /async function getProductsByIds\(ids: string\[\]\): Promise<TProduct\[]>/);
    assert.match(loadersSource, /async function getProductBySlug\(slug: string\): Promise<TProduct \| null>/);
    assert.match(loadersSource, /async function getAllProductSlugs\(\): Promise<Array<\{ slug: string \}>>/);
    assert.doesNotMatch(loadersSource, /getLegacyProductCatalogItems/);
    assert.doesNotMatch(loadersSource, /legacyProductCatalog/);
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

  it("omits products without filter attribute arrays from flattened catalog filters", () => {
    const loaderStart = loadersSource.indexOf("async function getProductFilterAttributes");
    const filterAttributesLoader = loadersSource.slice(
      loaderStart,
      loadersSource.indexOf("async function getProducts(", loaderStart),
    );

    assert.match(filterAttributesLoader, /_type == "product"/);
    assert.match(filterAttributesLoader, /defined\(filterAttributes\)/);
    assert.match(filterAttributesLoader, /filterAttributes\[defined\(label\) && defined\(value\)\]/);
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
