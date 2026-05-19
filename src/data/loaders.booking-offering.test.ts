import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const loadersSource = readFileSync(new URL("./loaders.ts", import.meta.url), "utf8");

describe("booking offering loader contract", () => {
  it("exposes active offering list and single offering-by-slug loaders", () => {
    assert.match(loadersSource, /async function getActiveBookingOfferings\(\)/);
    assert.match(loadersSource, /async function getBookingOfferingBySlug\(slug: string\)/);
    assert.match(loadersSource, /getActiveBookingOfferings,/);
    assert.match(loadersSource, /getBookingOfferingBySlug,/);
  });

  it("queries active bookingOffering documents with explicit projected fields", () => {
    assert.match(loadersSource, /\*\[_type == "bookingOffering" && isActive == true\]/);
    assert.match(loadersSource, /slug\.current == \$slug && isActive == true/);
    assert.match(loadersSource, /\*\[_type == "service" && isAvailable == true\]/);
    assert.match(loadersSource, /slug\.current == \$slug && isAvailable == true/);

    for (const projectedField of [
      "_id",
      "title",
      "description",
      '"slug": slug.current',
      "isActive",
      "bookingType",
      "durationMinutes",
      "slotIntervalMinutes",
      "bufferBeforeMinutes",
      "bufferAfterMinutes",
      "minimumLeadTimeHoursOverride",
      "paymentMode",
      "depositProduct->{",
      "fullProduct->{",
      "displayOrder",
    ]) {
      assert.ok(loadersSource.includes(projectedField), `${projectedField} should be projected`);
    }
  });

  it("uses the sellable product projection shape for deposit and full product references", () => {
    for (const projectedField of [
      "shortDescription",
      "sku",
      "kind",
      "price",
      "currency",
      "variants[]{ _key, title, sku, price, isAvailable, availabilityLabel }",
      "isAvailable",
      "availabilityLabel",
      "fulfillmentNote",
      "image{ asset, hotspot, crop, alt }",
    ]) {
      assert.ok(loadersSource.includes(projectedField), `${projectedField} should be projected`);
    }

    assert.match(loadersSource, /sanityFetchOptions\(\["bookingOffering", "sellableProduct"\]\)/);
  });

  it("maps canonical services to the booking offering shape without sellable product references", () => {
    assert.match(loadersSource, /const SERVICE_BOOKING_OFFERING_PROJECTION = groq`\{/);

    for (const projectedField of [
      "_id",
      "title",
      "description",
      '"slug": slug.current',
      '"isActive": isAvailable',
      "bookingType",
      "durationMinutes",
      "slotIntervalMinutes",
      "bufferBeforeMinutes",
      "bufferAfterMinutes",
      "minimumLeadTimeHoursOverride",
      "paymentMode",
      "displayOrder",
    ]) {
      assert.ok(loadersSource.includes(projectedField), `${projectedField} should be projected for services`);
    }

    const serviceProjection = loadersSource.slice(
      loadersSource.indexOf("const SERVICE_BOOKING_OFFERING_PROJECTION"),
      loadersSource.indexOf("async function getActiveBookingOfferings"),
    );

    assert.doesNotMatch(serviceProjection, /depositProduct|fullProduct|fullPrice|depositAmount/);
    assert.match(
      loadersSource,
      new RegExp("if \\(bookingOffering !== null\\) \\{\\n    return bookingOffering;\\n  \\}"),
    );
    assert.match(loadersSource, /sanityFetchOptions\(\["service"\]\)/);
  });

});
