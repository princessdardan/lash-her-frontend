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
      "service->{",
      "isActive",
      "bookingType",
      "durationMinutes",
      "slotIntervalMinutes",
      "bufferBeforeMinutes",
      "bufferAfterMinutes",
      "minimumLeadTimeHoursOverride",
      "depositAmount",
      "fullPrice",
      "currency",
      "displayOrder",
    ]) {
      assert.ok(loadersSource.includes(projectedField), `${projectedField} should be projected`);
    }
  });

  it("projects booking payment fields without product reference wrappers", () => {
    const bookingProjection = loadersSource.slice(
      loadersSource.indexOf("const BOOKING_OFFERING_PROJECTION"),
      loadersSource.indexOf("const SERVICE_BOOKING_OFFERING_PROJECTION"),
    );

    assert.doesNotMatch(bookingProjection, /depositProduct|fullProduct/);
    assert.match(loadersSource, /sanityFetchOptions\(\["bookingOffering"\]\)/);
  });

  it("maps canonical services to the booking offering shape without product reference wrappers", () => {
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
      "fullPrice",
      "depositAmount",
      "currency",
      "displayOrder",
    ]) {
      assert.ok(loadersSource.includes(projectedField), `${projectedField} should be projected for services`);
    }

    const serviceProjection = loadersSource.slice(
      loadersSource.indexOf("const SERVICE_BOOKING_OFFERING_PROJECTION"),
      loadersSource.indexOf("async function getActiveBookingOfferings"),
    );

    assert.doesNotMatch(serviceProjection, /depositProduct|fullProduct/);
    assert.match(loadersSource, /if \(bookingOffering !== null && isPaymentConfiguredBookingOffering\(bookingOffering\)\)/);
    assert.match(loadersSource, /sanityFetchOptions\(\["service"\]\)/);
  });

  it("keeps unconfigured payment documents out of active booking flows", () => {
    assert.match(loadersSource, /function isPaymentConfiguredBookingOffering\(offering: TBookingOffering\): boolean/);
    assert.match(loadersSource, /bookingOfferings\.filter\(isPaymentConfiguredBookingOffering\)/);
    assert.match(loadersSource, /services\.filter\(isPaymentConfiguredBookingOffering\)/);
    assert.match(loadersSource, /bookingOffering !== null && isPaymentConfiguredBookingOffering\(bookingOffering\)/);
    assert.match(loadersSource, /service !== null && isPaymentConfiguredBookingOffering\(service\) \? service : null/);
  });

});
