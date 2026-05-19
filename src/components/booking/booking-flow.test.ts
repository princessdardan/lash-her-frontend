import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const bookingFlowSource = readFileSync(new URL("./booking-flow.tsx", import.meta.url), "utf8");
const bookingPageSource = readFileSync(new URL("../../app/(site)/booking/page.tsx", import.meta.url), "utf8");

describe("booking offering flow contract", () => {
  it("initializes service offering links with the offering booking type", () => {
    assert.match(bookingPageSource, /const offering = offeringSlug \? await loaders\.getBookingOfferingBySlug\(offeringSlug\) : null/);
    assert.match(bookingPageSource, /offering\?\.bookingType \?\? normalizeType\(params\.type\)/);
  });

  it("locks the service type select for explicit offering links", () => {
    assert.match(bookingFlowSource, /const hasOffering = Boolean\(initialOfferingSlug\)/);
    assert.match(bookingFlowSource, /disabled=\{hasPaidTrainingOrder \|\| hasOffering\}/);
  });

  it("does not refetch availability when a non-paid booking email field changes", () => {
    assert.match(bookingFlowSource, /const availabilityEmail = hasPaidTrainingOrder \? email : ""/);
    assert.match(bookingFlowSource, /email: availabilityEmail/);
    assert.match(bookingFlowSource, /\[bookingType, availabilityEmail, hasPaidTrainingOrder/);
  });
});
