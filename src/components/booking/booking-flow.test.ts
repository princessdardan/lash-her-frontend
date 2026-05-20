import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const bookingFlowSource = readFileSync(new URL("./booking-flow.tsx", import.meta.url), "utf8");
const bookingPageSource = readFileSync(new URL("../../app/(site)/booking/page.tsx", import.meta.url), "utf8");
const productsPageSource = readFileSync(new URL("../../app/(site)/products/page.tsx", import.meta.url), "utf8");

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

  it("passes offeringPayment to BookingFlow", () => {
    assert.match(bookingPageSource, /offeringPayment=\{offeringPayment\}/);
    assert.match(bookingFlowSource, /offeringPayment\?: \{/);
  });

  it("uses /api/booking/holds and /api/booking/checkout for paid offerings", () => {
    assert.match(bookingFlowSource, /fetch\("\/api\/booking\/holds"/);
    assert.match(bookingFlowSource, /fetch\("\/api\/booking\/checkout"/);
    assert.match(bookingFlowSource, /paymentOption: offeringPayment\.paymentMode === "customPartial" \? paymentOption : offeringPayment\.paymentMode/);
    assert.match(bookingFlowSource, /body: JSON\.stringify\(\{\s*holdReference,\s*\}\)/);
  });

  it("does not collect appointment intake fields that paid offering checkout does not persist", () => {
    assert.match(bookingFlowSource, /const isPaidOfferingCheckout = offeringPayment !== undefined && hasOffering && !hasPaidTrainingOrder/);
    assert.match(bookingFlowSource, /const shouldCollectIntake = !isPaidOfferingCheckout/);
    assert.match(bookingFlowSource, /\{shouldCollectIntake && activeTypeConfig\?\.questions\.map/);
    assert.match(bookingFlowSource, /\{shouldCollectIntake && <div className="flex items-start gap-3 pt-4">/);
  });

  it("validates Helcim success before showing a confirmed paid appointment", () => {
    assert.match(bookingFlowSource, /fetch\("\/api\/checkout\/validate-payment"/);
    assert.match(bookingFlowSource, /Payment could not be verified/);
  });

  it("does not reference checkoutProduct in products page", () => {
    assert.doesNotMatch(productsPageSource, /checkoutProduct/);
  });
});
