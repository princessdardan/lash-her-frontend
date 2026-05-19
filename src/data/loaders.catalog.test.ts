import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const loadersSource = readFileSync(new URL("./loaders.ts", import.meta.url), "utf8");

describe("catalog loader contract", () => {
  it("keeps legacy sellable products visible in the Products section during migration", () => {
    assert.match(loadersSource, /async function getLegacyProductCatalogItems\(\): Promise<TProduct\[]>/);
    assert.match(loadersSource, /\.filter\(\(product\) => product\.kind === "product"\)/);
    assert.match(loadersSource, /\.map\(mapSellableProductToProduct\)/);
    assert.match(loadersSource, /const \[products, legacyProducts\] = await Promise\.all/);
    assert.match(loadersSource, /const uniqueLegacyProducts = legacyProducts\.filter/);
  });

  it("uses canonical products before same-id or same-slug legacy products", () => {
    assert.match(loadersSource, /new Set\(products\.flatMap\(\(product\) => \[product\._id, product\.slug\]\)\)/);
    assert.match(loadersSource, /!productKeys\.has\(product\._id\) && !productKeys\.has\(product\.slug\)/);
  });

  it("falls back to legacy product detail pages while sellableProduct is still registered", () => {
    assert.match(loadersSource, /const legacyProduct = await getSellableProductBySlug\(slug\)/);
    assert.match(loadersSource, /legacyProduct\?\.kind === "product" \? mapSellableProductToProduct\(legacyProduct\) : null/);
  });
});
