import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const loadersSource = readFileSync(
  new URL("./loaders.ts", import.meta.url),
  "utf8",
);

describe("catalog loader contract", () => {
  it("uses canonical products for public catalog and checkout loaders", () => {
    assert.match(
      loadersSource,
      /async function getProducts\(sort: ProductSort = "default"\): Promise<TProduct\[]>/,
    );
    assert.match(
      loadersSource,
      /async function getProductsByIds\(ids: string\[\]\): Promise<TProduct\[]>/,
    );
    assert.match(
      loadersSource,
      /async function getProductBySlug\(slug: string\): Promise<TProduct \| null>/,
    );
    assert.match(
      loadersSource,
      /async function getAllProductSlugs\(\): Promise<Array<\{ slug: string \}>>/,
    );
    assert.doesNotMatch(loadersSource, /getLegacyProductCatalogItems/);
    assert.doesNotMatch(loadersSource, /legacyProductCatalog/);
    assert.doesNotMatch(
      loadersSource,
      /getProductFilterAttributes|ProductFilters|filterAttributes/,
    );
  });

  it("projects optional merchant SKUs without exposing generated fallback codes", () => {
    const productProjection = loadersSource.slice(
      loadersSource.indexOf("const PRODUCT_PROJECTION"),
      loadersSource.indexOf("const SERVICE_PROJECTION"),
    );

    assert.match(productProjection, /sku/);
    assert.match(
      productProjection,
      /variants\[\]\{ _key, title, sku, price, discountPrice, isAvailable, availabilityLabel, options\[\]\{ _key, name, value \}, shipping \}/,
    );
    assert.match(productProjection, /^\s{2}variantModel,$/m);
    assert.match(productProjection, /^\s{2}shipping,$/m);
  });

  it("normalizes grouped product options at every public and checkout product boundary", () => {
    for (const loaderName of [
      "getProducts",
      "getProductsByIds",
      "getProductBySlug",
    ]) {
      assert.match(
        getFunctionSource(loaderName),
        /normalizeProductVariantModel/,
        `${loaderName} should normalize the shared commerce variant shape`,
      );
    }

    const controlStringKeysStart = loadersSource.indexOf(
      "const CONTROL_STRING_KEYS",
    );
    const controlStringKeysEnd = loadersSource.indexOf(
      "]);",
      controlStringKeysStart,
    );
    const controlStringKeys = loadersSource.slice(
      controlStringKeysStart,
      controlStringKeysEnd,
    );

    assert.doesNotMatch(
      controlStringKeys,
      /"name"/,
      "unrelated name fields should retain draft visual-edit metadata",
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

  it("keeps public service editorial reads separate from legacy commerce reads", () => {
    const editorialProjection = loadersSource.slice(
      loadersSource.indexOf("const SERVICE_PROJECTION"),
      loadersSource.indexOf("const LEGACY_SERVICE_PROJECTION"),
    );
    const legacyProjection = loadersSource.slice(
      loadersSource.indexOf("const LEGACY_SERVICE_PROJECTION"),
      loadersSource.indexOf("const TRAINING_PROGRAM_CATALOG_PROJECTION"),
    );

    for (const commerceField of [
      "addOns",
      "currency",
      "depositAmount",
      "displayOrder",
      "durationMinutes",
      "fullPrice",
      "isAvailable",
      "showDetailPage",
    ]) {
      assert.doesNotMatch(
        editorialProjection,
        new RegExp(`\\b${commerceField}\\b`),
      );
      assert.match(legacyProjection, new RegExp(`\\b${commerceField}\\b`));
    }
  });

  it("does not gate editorial service loaders on legacy availability", () => {
    const getServicesSource = getFunctionSource("getServices");
    const getServiceBySlugSource = getFunctionSource("getServiceBySlug");
    const getAllServiceSlugsSource = getFunctionSource("getAllServiceSlugs");

    assert.match(getServicesSource, /Promise<TServiceEditorial\[]>/);
    assert.match(getServiceBySlugSource, /Promise<TServiceEditorial \| null>/);
    assert.doesNotMatch(getServicesSource, /isAvailable/);
    assert.doesNotMatch(getServiceBySlugSource, /isAvailable/);
    assert.doesNotMatch(getAllServiceSlugsSource, /isAvailable/);
  });

  it("retains legacy V1 service eligibility in the promotion loader", () => {
    const getPromotionCodeSource = getFunctionSource("getPromotionCode");

    assert.match(getPromotionCodeSource, /services\[\]->\{ _id \}/);
    assert.match(
      getPromotionCodeSource,
      /\["promotionCode", "product", "trainingProgram", "service"\]/,
    );
    assert.match(
      getPromotionCodeSource,
      /\{ mode: "published", stega: false \}/,
    );
  });
});

function getFunctionSource(name: string): string {
  const start = loadersSource.indexOf(`async function ${name}(`);
  assert.notStrictEqual(start, -1, `${name} should exist`);

  const end = loadersSource.indexOf("\nasync function ", start + 1);
  return end === -1
    ? loadersSource.slice(start)
    : loadersSource.slice(start, end);
}
