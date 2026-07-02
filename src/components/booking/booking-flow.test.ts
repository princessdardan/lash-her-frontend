import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { loadSquareScript } from "./square-card-on-file-form";
import { createBookingHold } from "./booking-flow";

const bookingFlowSource = readFileSync(
  new URL("./booking-flow.tsx", import.meta.url),
  "utf8",
);
const serviceBookingPaymentFormSource = readFileSync(
  new URL("./service-booking-payment-form.tsx", import.meta.url),
  "utf8",
);
const serviceBookingPaymentShellSource = readFileSync(
  new URL("./service-booking-payment-shell.tsx", import.meta.url),
  "utf8",
);
const chargeAndStoreSource = readFileSync(
  new URL("./square-charge-and-store-form.tsx", import.meta.url),
  "utf8",
);
const bookingPageSource = readFileSync(
  new URL("../../app/(site)/booking/page.tsx", import.meta.url),
  "utf8",
);
const bookingShimSource = readFileSync(
  new URL("../../app/(site)/booking/booking-shim.ts", import.meta.url),
  "utf8",
);
const productCardSource = readFileSync(
  new URL("../commerce/product-card.tsx", import.meta.url),
  "utf8",
);
const servicesPageSource = readFileSync(
  new URL("../../app/(site)/services/page.tsx", import.meta.url),
  "utf8",
);
const bookingConfirmationSource = readFileSync(
  new URL("../../app/(site)/booking/confirmation/page.tsx", import.meta.url),
  "utf8",
);
const loadersSource = readFileSync(
  new URL("../../data/loaders.ts", import.meta.url),
  "utf8",
);
const typesSource = readFileSync(
  new URL("../../types/index.ts", import.meta.url),
  "utf8",
);

describe("booking service flow contract", () => {
  it("projects service add-ons with stable keys and image metadata", () => {
    assert.match(typesSource, /export interface TServiceAddOn/);
    assert.match(typesSource, /addOns\?: TServiceAddOn\[\]/);
    assert.match(
      loadersSource,
      /addOns\[\]\{ _key, name, description, price, image\{ asset, hotspot, crop, alt \} \}/,
    );
  });

  it("initializes service offering redirects through the booking shim helper", () => {
    assert.match(bookingPageSource, /resolveBookingShim\(await searchParams/);
    assert.match(
      bookingPageSource,
      /if \(resolution\.kind === "redirect"\) \{/,
    );
    assert.match(bookingShimSource, /getBookableServiceBySlug/);
    assert.match(bookingShimSource, /buildServiceBookingUrl/);
  });

  it("skips the service selection step for explicit service links", () => {
    assert.match(
      bookingFlowSource,
      /const hasInitialService = Boolean\(initialServiceSlug\)/,
    );
    assert.match(
      bookingFlowSource,
      /hasInitialService \? "datetime" : "service"/,
    );
  });

  it("does not refetch availability when customer fields change", () => {
    assert.match(bookingFlowSource, /fetchAvailability\(selectedServiceSlug\)/);
    assert.match(bookingFlowSource, /\[selectedServiceSlug, step\]/);
  });

  it("renders availability errors before showing the generic no-times state", () => {
    const errorBranchIndex = bookingFlowSource.indexOf(") : errorMessage ? (");
    const noTimesBranchIndex = bookingFlowSource.indexOf(
      "No times available for this service.",
    );

    assert.ok(errorBranchIndex > -1);
    assert.ok(noTimesBranchIndex > -1);
    assert.ok(errorBranchIndex < noTimesBranchIndex);
    assert.match(
      bookingFlowSource,
      /setSlots\(\[\]\);\s*setSelectedSlot\(""\);\s*setSelectedDateState\(""\);/,
    );
    assert.match(bookingFlowSource, /setIsLoadingSlots\(false\);/);
  });

  it("limits the date selector to seven visible carousel dates", () => {
    assert.match(bookingFlowSource, /const VISIBLE_DATE_COUNT = 7;/);
    assert.match(
      bookingFlowSource,
      /availableDates\.slice\(\s*effectiveDateWindowStart,\s*effectiveDateWindowStart \+ VISIBLE_DATE_COUNT,\s*\)/,
    );
    assert.match(bookingFlowSource, /visibleDates\.map/);
    assert.match(bookingFlowSource, /Show previous available dates/);
    assert.match(bookingFlowSource, /Show next available dates/);
    assert.doesNotMatch(bookingFlowSource, /availableDates\.map\(\(dateStr\)/);
  });

  it("shows a service selection empty state when no offerings are configured", () => {
    assert.match(bookingFlowSource, /services\.length === 0 \? \(/);
    assert.match(
      bookingFlowSource,
      /We are currently updating our services\. Please check back later\./,
    );
  });

  it("passes only the active booking flow state to BookingFlow", () => {
    assert.doesNotMatch(bookingPageSource, /initialBookingType=/);
    assert.doesNotMatch(bookingPageSource, /servicePayment=\{servicePayment\}/);
    assert.doesNotMatch(bookingPageSource, /paidTrainingOrderId=/);
  });

  it("redirects service booking holds to a dedicated payment page", () => {
    assert.match(bookingFlowSource, /paymentPageUrl/);
    assert.match(
      bookingFlowSource,
      /window\.location\.assign\(paymentPageUrl\)/,
    );
    assert.doesNotMatch(bookingFlowSource, /cardOnFileHoldReference/);
  });

  it("renders a single optional add-on picker", () => {
    assert.match(bookingFlowSource, /selectedAddOnKey/);
    assert.match(bookingFlowSource, /Optional add-on/);
    assert.match(bookingFlowSource, /No add-on/);
    assert.match(bookingFlowSource, /Only one add-on can be selected/);
    assert.match(bookingFlowSource, /type="radio"/);
    assert.doesNotMatch(bookingFlowSource, /role="radio(?:group)?"/);
  });

  it("clears selected add-ons when the selected service changes", () => {
    assert.match(bookingFlowSource, /setSelectedAddOnKey\(null\)/);
  });

  it("posts only the selected add-on key to private hold creation", () => {
    assert.match(
      bookingFlowSource,
      /selectedAddOnKey: input\.selectedAddOnKey/,
    );
    assert.doesNotMatch(
      bookingFlowSource,
      /selectedAddOnName|selectedAddOnPrice|computedTotal/,
    );
  });

  it("booking page collects service details only before payment", () => {
    assert.match(bookingFlowSource, /Appointment Details/);
    assert.match(bookingFlowSource, /Optional add-on/);
    assert.match(bookingFlowSource, /intakeQuestions\.map/);
    assert.doesNotMatch(bookingFlowSource, /Full Name/);
    assert.doesNotMatch(bookingFlowSource, /Email Address/);
    assert.doesNotMatch(bookingFlowSource, /Phone Number/);
    assert.doesNotMatch(bookingFlowSource, /Payment Details/);
    assert.doesNotMatch(bookingFlowSource, /marketingOptIn/);
  });

  it("booking hold creation posts no contact, marketing, or payment amount fields", () => {
    assert.match(
      bookingFlowSource,
      /selectedAddOnKey: input\.selectedAddOnKey/,
    );
    assert.doesNotMatch(bookingFlowSource, /email: input\.email/);
    assert.doesNotMatch(bookingFlowSource, /name: input\.name/);
    assert.doesNotMatch(bookingFlowSource, /phone: input\.phone/);
    assert.doesNotMatch(
      bookingFlowSource,
      /paymentOption: input\.paymentOption/,
    );
    assert.doesNotMatch(bookingFlowSource, /customAmount: input\.customAmount/);
    assert.doesNotMatch(bookingFlowSource, /marketingConsentText/);
  });

  it("does not render Helcim Pay or Google Appointment Schedule UI for service bookings", () => {
    assert.doesNotMatch(
      bookingFlowSource,
      /appendHelcimPayIframe|removeHelcimPayIframe|secure\.helcim\.app|\/api\/checkout\/validate-payment/,
    );
    assert.doesNotMatch(
      bookingFlowSource,
      /<iframe|iframe|Appointment Schedule|appointments\.google\.com/i,
    );
    assert.match(bookingFlowSource, /Continue to payment/);
  });

  it("shows Square return status copy without private identifiers", () => {
    assert.match(bookingConfirmationSource, /Payment verification pending/);
    assert.match(bookingConfirmationSource, /Rebooking pending/);
    assert.match(bookingConfirmationSource, /Payment under review/);
    assert.match(bookingConfirmationSource, /Booking confirmed/);
    assert.match(
      bookingConfirmationSource,
      /No private payment identifiers are shown here/,
    );
    assert.doesNotMatch(
      bookingConfirmationSource,
      /squarePaymentLinkId|squareOrderId|holdReference/,
    );
  });

  it("keeps booking checkout decoupled while product cards support product buy-now checkout", () => {
    assert.doesNotMatch(
      productCardSource,
      /\/api\/booking|holdReference|squareOrderId|squarePaymentLinkId/,
    );
    assert.match(productCardSource, /buyNow: "1"/);
    assert.match(productCardSource, /productId: product\._id/);
    assert.match(
      productCardSource,
      /router\.push\(`\/checkout\?\$\{params\.toString\(\)\}`\)/,
    );
  });

  it("keeps service detail links discoverable outside the active offerings branch", () => {
    const emptyOfferingsIndex = servicesPageSource.indexOf(
      "bookableServices.length === 0",
    );
    const detailServicesIndex = servicesPageSource.indexOf(
      "detailServices.length > 0",
    );

    assert.ok(emptyOfferingsIndex > -1);
    assert.ok(detailServicesIndex > emptyOfferingsIndex);
    assert.match(
      servicesPageSource,
      /href=\{`\/services\/\$\{service\.slug\}`\}/,
    );
  });

  it("service listing booking links use /services/<slug>/booking", () => {
    assert.match(
      servicesPageSource,
      /href=\{`\/services\/\$\{service\.slug\}\/booking`\}/,
    );
  });

  it("service detail booking link uses /services/<slug>/booking", () => {
    const serviceDetailPageSource = readFileSync(
      new URL("../../app/(site)/services/[slug]/page.tsx", import.meta.url),
      "utf8",
    );
    assert.match(
      serviceDetailPageSource,
      /href=\{`\/services\/\$\{service\.slug\}\/booking`\}/,
    );
  });

  it("product cards link products through /products/<slug>", () => {
    assert.match(
      productCardSource,
      /const productHref = `\/products\/\$\{product\.slug\}`;/,
    );
    assert.match(productCardSource, /<Link\s+href=\{productHref\}/);
  });

  it("no /booking?offering= remains in these canonical service CTA surfaces", () => {
    const serviceDetailPageSource = readFileSync(
      new URL("../../app/(site)/services/[slug]/page.tsx", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(servicesPageSource, /\/booking\?offering=/);
    assert.doesNotMatch(productCardSource, /\/booking\?offering=/);
    assert.doesNotMatch(serviceDetailPageSource, /\/booking\?offering=/);
  });

  it("returns payment page handoff from a successful hold", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = input.toString();
      requests.push({
        url,
        body: parseJsonBody(init?.body),
      });

      if (url === "/api/booking/holds") {
        return Response.json({
          hold: {
            paymentPageUrl:
              "/services/classic-fill/booking/payment?session=pay_sess_test_1",
            paymentSessionReference: "pay_sess_test_1",
          },
        });
      }

      return Response.json({ error: "Unexpected request" }, { status: 500 });
    };

    const result = await createBookingHold({
      serviceSlug: "classic-fill",
      start: "2030-06-15T16:00:00.000Z",
      answers: [],
      selectedAddOnKey: "addon-lash-bath",
      fetcher,
    });

    assert.deepEqual(result, {
      paymentPageUrl:
        "/services/classic-fill/booking/payment?session=pay_sess_test_1",
      paymentSessionReference: "pay_sess_test_1",
    });
    assert.deepEqual(requests, [
      {
        url: "/api/booking/holds",
        body: {
          serviceSlug: "classic-fill",
          start: "2030-06-15T16:00:00.000Z",
          answers: [],
          selectedAddOnKey: "addon-lash-bath",
        },
      },
    ]);
  });

  it("surfaces hold failures before payment navigation", async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      requests.push(input.toString());
      return Response.json(
        { error: "Selected time is no longer available." },
        { status: 409 },
      );
    };

    await assert.rejects(
      createBookingHold({
        serviceSlug: "classic-fill",
        start: "2030-06-15T16:00:00.000Z",
        answers: [],
        fetcher,
      }),
      /Selected time is no longer available\./,
    );
    assert.deepEqual(requests, ["/api/booking/holds"]);
  });

  it("booking page copy sends customers to payment after service details", () => {
    const serviceBookingPageSource = readFileSync(
      new URL(
        "../../app/(site)/services/[slug]/booking/page.tsx",
        import.meta.url,
      ),
      "utf8",
    );

    assert.match(
      serviceBookingPageSource,
      /Select your appointment time, add-ons, and service details before payment\./,
    );
    assert.doesNotMatch(serviceBookingPageSource, /confirm your details/i);
  });

  it("payment page owns contact, marketing, payment, consent, and Square card entry", () => {
    assert.match(serviceBookingPaymentFormSource, /Full Name/);
    assert.match(serviceBookingPaymentFormSource, /Email Address/);
    assert.match(serviceBookingPaymentFormSource, /Phone Number/);
    assert.match(serviceBookingPaymentFormSource, /Marketing/);
    assert.match(serviceBookingPaymentFormSource, /Payment Option/);
    assert.match(
      serviceBookingPaymentFormSource,
      /SERVICE_NO_SHOW_POLICY_TEXT/,
    );
    assert.match(chargeAndStoreSource, /intent: "CHARGE_AND_STORE"/);
    assert.match(chargeAndStoreSource, /countryCode: "CA"/);
    assert.match(chargeAndStoreSource, /billingContact/);
    assert.doesNotMatch(chargeAndStoreSource, /intent: "STORE"/);
  });

  it("renders the canonical no-show policy text and max charge amount before consent", () => {
    assert.match(
      serviceBookingPaymentFormSource,
      /SERVICE_NO_SHOW_POLICY_TEXT/,
    );
    assert.match(serviceBookingPaymentFormSource, /Maximum no-show amount/);
    assert.match(
      serviceBookingPaymentFormSource,
      /No-show &amp; late cancellation policy/,
    );
  });

  it("payment copy does not promise that no payment is taken today", () => {
    assert.doesNotMatch(
      serviceBookingPaymentShellSource,
      /No payment is taken today/i,
    );
    assert.match(
      serviceBookingPaymentShellSource,
      /Pay and confirm your booking/,
    );
    assert.match(
      serviceBookingPaymentShellSource,
      /Today’s payment secures your appointment/,
    );
  });

  it("posts the Task 5 confirm body shape from the payment form", () => {
    assert.match(
      serviceBookingPaymentFormSource,
      /"\/api\/booking\/payment\/confirm"/,
    );
    assert.match(
      serviceBookingPaymentFormSource,
      /paymentSessionReference:\s*session\.paymentSessionReference/,
    );
    assert.match(serviceBookingPaymentFormSource, /customer:\s*\{/);
    assert.match(serviceBookingPaymentFormSource, /marketingOptIn/);
    assert.match(serviceBookingPaymentFormSource, /payment:\s*\{/);
    assert.match(serviceBookingPaymentFormSource, /expectedAmountCents/);
    assert.match(serviceBookingPaymentFormSource, /policy:\s*\{/);
    assert.match(serviceBookingPaymentFormSource, /policyTextHash/);
    assert.match(
      serviceBookingPaymentFormSource,
      /policyVersion:\s*SERVICE_NO_SHOW_POLICY_VERSION/,
    );
    assert.match(
      serviceBookingPaymentFormSource,
      /sourceId:\s*token\.sourceId/,
    );
    assert.match(
      serviceBookingPaymentFormSource,
      /verificationToken:\s*token\.verificationToken/,
    );
    assert.match(serviceBookingPaymentFormSource, /idempotencyKey/);
  });

  it("guards against duplicate submit before React state updates", () => {
    assert.match(serviceBookingPaymentFormSource, /submissionInFlightRef/);
    assert.match(
      serviceBookingPaymentFormSource,
      /if \(submissionInFlightRef\.current\) \{/,
    );
    assert.match(
      serviceBookingPaymentFormSource,
      /submissionInFlightRef\.current = true/,
    );
    assert.match(
      serviceBookingPaymentFormSource,
      /submissionInFlightRef\.current = false/,
    );
  });

  it("hardens the card display type guard to typed optional fields", () => {
    const guardSource = serviceBookingPaymentFormSource.match(
      /function isCardDisplay\([\s\S]*?\n\}/,
    )?.[0];

    assert.ok(guardSource, "expected isCardDisplay function in payment form");
    assert.match(
      guardSource,
      /record\.brand !== undefined[\s\S]*?typeof record\.brand !== "string"/,
      "brand must be a string when present",
    );
    assert.match(
      guardSource,
      /record\.last4 !== undefined[\s\S]*?typeof record\.last4 !== "string"/,
      "last4 must be a string when present",
    );
    assert.match(
      guardSource,
      /record\.expMonth !== undefined[\s\S]*?typeof record\.expMonth !== "number"/,
      "expMonth must be a number when present",
    );
    assert.match(
      guardSource,
      /record\.expYear !== undefined[\s\S]*?typeof record\.expYear !== "number"/,
      "expYear must be a number when present",
    );
  });

  it("initializes Square charge-and-store form from config and Web Payments SDK", () => {
    assert.match(chargeAndStoreSource, /fetchSquareCardOnFileConfig/);
    assert.match(
      chargeAndStoreSource,
      /window as unknown as \{ Square\?: SquareGlobal \}/,
    );
    assert.match(chargeAndStoreSource, /square-charge-card-container/);
    assert.match(chargeAndStoreSource, /intent:\s*"CHARGE_AND_STORE"/);
    assert.match(chargeAndStoreSource, /customerInitiated:\s*true/);
    assert.match(chargeAndStoreSource, /sellerKeyedIn:\s*false/);
    assert.match(chargeAndStoreSource, /currencyCode:\s*"CAD"/);
    assert.doesNotMatch(chargeAndStoreSource, /intent:\s*"STORE"/);
  });

  it("charge-and-store form passes verificationDetails directly to Square tokenize", async () => {
    const source = await readFile(
      new URL("./square-charge-and-store-form.tsx", import.meta.url),
      "utf8",
    );

    assert.match(source, /cardRef\.current\.tokenize\(verificationDetails\)/);
    assert.doesNotMatch(source, /tokenize\(\{\s*verificationDetails\s*\}\)/);
  });

  it("keeps the Square card container mounted while initializing", () => {
    assert.doesNotMatch(
      chargeAndStoreSource,
      /if \(isConfigLoading \|\| isInitializing\) \{[\s\S]*?return \(/,
    );
    assert.match(chargeAndStoreSource, /cardContainerId/);
    assert.match(
      chargeAndStoreSource,
      /await card\.attach\(`#\$\{cardContainerId\}`\)/,
    );

    const cardContainerIndex = chargeAndStoreSource.indexOf("cardContainerId");
    const earlyConfigNullReturn = chargeAndStoreSource.indexOf(
      "if (config === null) return null",
    );
    assert.ok(
      earlyConfigNullReturn === -1 ||
        cardContainerIndex < earlyConfigNullReturn,
      "card container must be rendered before any config-unavailable early return",
    );
  });

  it("renders the Square card container as a div or span, not a section", () => {
    const containerMatch = chargeAndStoreSource.match(
      /<(section|div|span)\b[^>]*\sid=\{cardContainerId\}/,
    );

    assert.ok(
      containerMatch,
      "expected a section/div/span element with id={cardContainerId}",
    );
    assert.notEqual(
      containerMatch[1],
      "section",
      "Square card container must not be a <section>; card.attach() only accepts DIV or SPAN containers",
    );
    assert.match(
      containerMatch[1],
      /^(div|span)$/,
      "Square card container must be a <div> or <span>",
    );
  });

  it("cleans up a created Square card when attach fails", () => {
    // The attach call must be wrapped so a rejection destroys the card instance
    // before the error propagates; otherwise Square iframes/state may leak.
    assert.match(
      chargeAndStoreSource,
      /try \{\s*await card\.attach\(`#\$\{cardContainerId\}`\);\s*\} catch \(attachError: unknown\) \{\s*card\.destroy\(\);\s*throw attachError;\s*\}/,
    );
  });

  it("does not nest a form inside the parent booking form", () => {
    assert.doesNotMatch(chargeAndStoreSource, /<form\b/);
    assert.doesNotMatch(chargeAndStoreSource, /<form\s/);
    assert.doesNotMatch(chargeAndStoreSource, /type="submit"/);
  });

  it("does not expose Square identifiers or raw tokens in charge-and-store UI", () => {
    assert.doesNotMatch(chargeAndStoreSource, /squareCardId/);
    assert.doesNotMatch(chargeAndStoreSource, /squareCustomerId/);
    assert.doesNotMatch(chargeAndStoreSource, /cnon:/);
    assert.doesNotMatch(chargeAndStoreSource, /squareInvoiceId/);
    assert.doesNotMatch(chargeAndStoreSource, /squareOrderId/);
  });

  it("loads Square script through the shared helper for charge-and-store", () => {
    assert.match(chargeAndStoreSource, /loadSquareScript/);
  });

  it("shares a single loading promise per Square script URL", async () => {
    const doc = createFakeDocument();
    const url = "https://sandbox.web.squarecdn.com/v1/square.js?id=shared";

    const p1 = loadSquareScript(url, doc as unknown as Document);
    const p2 = loadSquareScript(url, doc as unknown as Document);

    assert.strictEqual(p1, p2);
    assert.equal(doc.scripts.length, 1);

    doc.scripts[0].dispatchEvent("load");
    await assert.doesNotReject(p1);
  });

  it("removes a failed Square script and allows retry", async () => {
    const doc = createFakeDocument();
    const url = "https://sandbox.web.squarecdn.com/v1/square.js?id=fail";

    const p1 = loadSquareScript(url, doc as unknown as Document);
    doc.scripts[0].dispatchEvent("error");

    await assert.rejects(p1, /Failed to load Square payments script/);
    assert.equal(doc.scripts.length, 0);

    const p2 = loadSquareScript(url, doc as unknown as Document);
    assert.notStrictEqual(p1, p2);
    assert.equal(doc.scripts.length, 1);

    doc.scripts[0].dispatchEvent("load");
    await assert.doesNotReject(p2);
  });

  it("waits for an existing script element to finish loading", async () => {
    const doc = createFakeDocument();
    const url = "https://sandbox.web.squarecdn.com/v1/square.js?id=existing";
    const existing = doc.createElement("script") as FakeScript;
    existing.src = url;

    const p = loadSquareScript(url, doc as unknown as Document);
    existing.dispatchEvent("load");

    await assert.doesNotReject(p);
  });
});

function parseJsonBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    throw new TypeError("Expected JSON request body");
  }

  return JSON.parse(body);
}

type FakeScript = {
  src: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  dispatchEvent(type: string): void;
  addEventListener(type: string, handler: () => void): void;
  remove(): void;
};

function createFakeDocument() {
  const scripts: FakeScript[] = [];

  return {
    scripts,
    head: {
      appendChild() {
        /* no-op */
      },
    },
    querySelector(selector: string) {
      return scripts.find((script) => selector.includes(script.src)) ?? null;
    },
    createElement(tagName: string) {
      if (tagName !== "script") {
        throw new Error(`Unexpected element: ${tagName}`);
      }

      const listeners: Record<string, Array<() => void>> = {};
      const script: FakeScript = {
        src: "",
        onload: null,
        onerror: null,
        addEventListener(type, handler) {
          if (listeners[type] === undefined) {
            listeners[type] = [];
          }
          listeners[type].push(handler);
        },
        dispatchEvent(type) {
          (listeners[type] ?? []).forEach((handler) => {
            handler();
          });
          if (type === "load") script.onload?.();
          if (type === "error") script.onerror?.();
        },
        remove() {
          const index = scripts.indexOf(script);
          if (index > -1) {
            scripts.splice(index, 1);
          }
        },
      };

      scripts.push(script);
      return script;
    },
  };
}
