import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { startPaidOfferingCheckout } from "./booking-flow";

const bookingFlowSource = readFileSync(new URL("./booking-flow.tsx", import.meta.url), "utf8");
const bookingPageSource = readFileSync(new URL("../../app/(site)/booking/page.tsx", import.meta.url), "utf8");
const bookingShimSource = readFileSync(new URL("../../app/(site)/booking/booking-shim.ts", import.meta.url), "utf8");
const productsPageSource = readFileSync(new URL("../../app/(site)/products/page.tsx", import.meta.url), "utf8");
const servicesPageSource = readFileSync(new URL("../../app/(site)/services/page.tsx", import.meta.url), "utf8");

describe("booking offering flow contract", () => {
  it("initializes service offering redirects through the booking shim helper", () => {
    assert.match(bookingPageSource, /resolveBookingShim\(await searchParams/);
    assert.match(bookingPageSource, /if \(resolution\.kind === "redirect"\) \{/);
    assert.match(bookingShimSource, /getBookingOfferingBySlug/);
    assert.match(bookingShimSource, /buildServiceBookingUrl/);
  });

  it("skips the service selection step for explicit offering links", () => {
    assert.match(bookingFlowSource, /const hasOffering = Boolean\(initialOfferingSlug\)/);
    assert.match(bookingFlowSource, /\(hasPaidTraining \|\| hasOffering \|\| initialBookingType\) \? "datetime" : "service"/);
  });

  it("does not refetch availability when a non-paid booking email field changes", () => {
    assert.match(bookingFlowSource, /const availabilityEmail = hasPaidTrainingOrder \? email : ""/);
    assert.match(bookingFlowSource, /email: availabilityEmail/);
    assert.match(bookingFlowSource, /\[step, currentBookingType, availabilityEmail, hasPaidTrainingOrder/);
  });

  it("renders availability errors before showing the generic no-times state", () => {
    const errorBranchIndex = bookingFlowSource.indexOf(') : errorMessage ? (');
    const noTimesBranchIndex = bookingFlowSource.indexOf('No times available for this service.');

    assert.ok(errorBranchIndex > -1);
    assert.ok(noTimesBranchIndex > -1);
    assert.ok(errorBranchIndex < noTimesBranchIndex);
    assert.match(bookingFlowSource, /setSlots\(\[\]\);\s*setSelectedSlot\(""\);\s*setIsLoadingSlots\(false\);/);
  });

  it("shows a service selection empty state when no offerings are configured", () => {
    assert.match(bookingFlowSource, /offerings\.length === 0 \? \(/);
    assert.match(bookingFlowSource, /We are currently updating our services\. Please check back later\./);
  });

  it("passes only the active booking flow state to BookingFlow", () => {
    assert.match(bookingPageSource, /initialBookingType=\{resolution\.initialBookingType\}/);
    assert.doesNotMatch(bookingPageSource, /offeringPayment=\{offeringPayment\}/);
    assert.doesNotMatch(bookingPageSource, /paidTrainingOrderId=/);
  });

  it("uses /api/booking/holds and /api/booking/checkout for paid offerings", () => {
    assert.match(bookingFlowSource, /startPaidOfferingCheckout\(\{/);
    assert.match(bookingFlowSource, /fetcher\("\/api\/booking\/holds"/);
    assert.match(bookingFlowSource, /fetcher\("\/api\/booking\/checkout"/);
    assert.match(bookingFlowSource, /paymentOption,/);
    assert.match(bookingFlowSource, /body: JSON\.stringify\(\{\s*holdReference,\s*\}\)/);
  });

  it("renders all purchaser payment options for paid offerings", () => {
    assert.match(bookingFlowSource, /Pay Deposit/);
    assert.match(bookingFlowSource, /Pay in Full/);
    assert.match(bookingFlowSource, /Pay Custom Amount/);
    assert.match(bookingFlowSource, /Custom amount must be greater than the deposit/);
    assert.match(bookingFlowSource, /Custom amount must be less than the full price/);
  });

  it("does not collect appointment intake fields that paid offering checkout does not persist", () => {
    assert.match(bookingFlowSource, /const isPaidOfferingCheckout = currentOfferingPayment !== undefined && Boolean\(selectedOfferingSlug\) && !hasPaidTraining/);
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

  it("keeps service detail links discoverable outside the active offerings branch", () => {
    const emptyOfferingsIndex = servicesPageSource.indexOf("offerings.length === 0");
    const detailServicesIndex = servicesPageSource.indexOf("detailServices.length > 0");

    assert.ok(emptyOfferingsIndex > -1);
    assert.ok(detailServicesIndex > emptyOfferingsIndex);
    assert.match(servicesPageSource, /href=\{`\/services\/\$\{service\.slug\}`\}/);
  });

  it("service listing offering links use /services/<slug>/booking", () => {
    assert.match(servicesPageSource, /href=\{`\/services\/\$\{offering\.slug\}\/booking`\}/);
  });

  it("service detail booking link uses /services/<slug>/booking", () => {
    const serviceDetailPageSource = readFileSync(new URL("../../app/(site)/services/[slug]/page.tsx", import.meta.url), "utf8");
    assert.match(serviceDetailPageSource, /href=\{`\/services\/\$\{service\.slug\}\/booking`\}/);
  });

  it("product catalog services without detail pages use /services/<slug>/booking", () => {
    assert.match(productsPageSource, /href = service\.showDetailPage\s*\?\s*`\/services\/\$\{service\.slug\}`\s*:\s*`\/services\/\$\{service\.slug\}\/booking`/);
  });

  it("no /booking?offering= remains in these canonical service CTA surfaces", () => {
    const serviceDetailPageSource = readFileSync(new URL("../../app/(site)/services/[slug]/page.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(servicesPageSource, /\/booking\?offering=/);
    assert.doesNotMatch(productsPageSource, /\/booking\?offering=/);
    assert.doesNotMatch(serviceDetailPageSource, /\/booking\?offering=/);
  });

  it("starts paid offering checkout with hold and checkout requests", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = input.toString();
      requests.push({
        url,
        body: parseJsonBody(init?.body),
      });

      if (url === "/api/booking/holds") {
        return Response.json({ hold: { reference: "hold_public_123" } });
      }

      if (url === "/api/booking/checkout") {
        return Response.json({ checkoutToken: "checkout_token_123" });
      }

      return Response.json({ error: "Unexpected request" }, { status: 500 });
    };

    const checkoutToken = await startPaidOfferingCheckout({
      offeringSlug: "classic-full-set",
      start: "2030-06-15T16:00:00.000Z",
      name: "Test Client",
      email: "test.client@example.com",
      phone: "(555) 123-4567",
      paymentOption: "customPartial",
      customAmount: 75,
      fetcher,
    });

    assert.equal(checkoutToken, "checkout_token_123");
    assert.deepEqual(requests, [
      {
        url: "/api/booking/holds",
        body: {
          offeringSlug: "classic-full-set",
          start: "2030-06-15T16:00:00.000Z",
          name: "Test Client",
          email: "test.client@example.com",
          phone: "(555) 123-4567",
          paymentOption: "customPartial",
          customAmount: 75,
        },
      },
      {
        url: "/api/booking/checkout",
        body: {
          holdReference: "hold_public_123",
        },
      },
    ]);
  });

  it("surfaces paid offering hold failures before checkout starts", async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      requests.push(input.toString());
      return Response.json({ error: "Selected time is no longer available." }, { status: 409 });
    };

    await assert.rejects(
      startPaidOfferingCheckout({
        offeringSlug: "classic-full-set",
        start: "2030-06-15T16:00:00.000Z",
        name: "Test Client",
        email: "test.client@example.com",
        phone: "(555) 123-4567",
        paymentOption: "deposit",
        fetcher,
      }),
      /Selected time is no longer available\./,
    );
    assert.deepEqual(requests, ["/api/booking/holds"]);
  });
});

function parseJsonBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    throw new TypeError("Expected JSON request body");
  }

  return JSON.parse(body);
}
