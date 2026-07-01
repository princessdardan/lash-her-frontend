import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  confirmCardOnFileBooking,
  fetchSquareCardOnFileConfig,
  loadSquareScript,
} from "./square-card-on-file-form";
import { createBookingHold } from "./booking-flow";
import { startLegacySquareCheckout } from "./service-booking-payment-client";

const bookingFlowSource = readFileSync(
  new URL("./booking-flow.tsx", import.meta.url),
  "utf8",
);
const cardOnFileFormSource = readFileSync(
  new URL("./square-card-on-file-form.tsx", import.meta.url),
  "utf8",
);
const serviceBookingPaymentShellSource = readFileSync(
  new URL("./service-booking-payment-shell.tsx", import.meta.url),
  "utf8",
);
const serviceBookingPaymentClientSource = readFileSync(
  new URL("./service-booking-payment-client.ts", import.meta.url),
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

  it("renders all purchaser payment options for paid services", () => {
    assert.match(bookingFlowSource, /Pay Deposit/);
    assert.match(bookingFlowSource, /Pay in Full/);
    assert.match(bookingFlowSource, /Pay Custom Amount/);
    assert.match(
      bookingFlowSource,
      /Custom amount must be greater than the deposit/,
    );
    assert.match(
      bookingFlowSource,
      /Custom amount must be less than the full price/,
    );
  });

  it("renders a single optional add-on picker and explains due-later balances", () => {
    assert.match(bookingFlowSource, /selectedAddOnKey/);
    assert.match(bookingFlowSource, /Optional add-on/);
    assert.match(bookingFlowSource, /No add-on/);
    assert.match(bookingFlowSource, /Only one add-on can be selected/);
    assert.match(bookingFlowSource, /add-on balance is due later/i);
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

  it("does not collect appointment intake fields that paid offering checkout does not persist", () => {
    assert.match(
      bookingFlowSource,
      /const currentServicePayment = currentService/,
    );
    assert.match(
      bookingFlowSource,
      /const intakeQuestions = settings.intakeQuestions/,
    );
    assert.match(bookingFlowSource, /intakeQuestions\.map/);
    assert.match(bookingFlowSource, /settings.marketingOptInLabel/);
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
    assert.match(bookingFlowSource, /Continue to secure Square checkout/);
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
      name: "Test Client",
      email: "test.client@example.com",
      phone: "(555) 123-4567",
      answers: [],
      marketingOptIn: false,
      paymentOption: "customPartial",
      customAmount: 75,
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
          name: "Test Client",
          email: "test.client@example.com",
          phone: "(555) 123-4567",
          answers: [],
          marketingOptIn: false,
          paymentOption: "customPartial",
          customAmount: 75,
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
        name: "Test Client",
        email: "test.client@example.com",
        phone: "(555) 123-4567",
        answers: [],
        marketingOptIn: false,
        paymentOption: "deposit",
        fetcher,
      }),
      /Selected time is no longer available\./,
    );
    assert.deepEqual(requests, ["/api/booking/holds"]);
  });

  it("initializes Square card-on-file form from config and Web Payments SDK", () => {
    assert.match(cardOnFileFormSource, /\/api\/booking\/square\/config/);
    assert.match(cardOnFileFormSource, /window\.Square\.payments/);
    assert.match(cardOnFileFormSource, /square-card-container/);
    assert.match(cardOnFileFormSource, /intent:\s*"STORE"/);
    assert.match(cardOnFileFormSource, /customerInitiated:\s*true/);
    assert.match(cardOnFileFormSource, /sellerKeyedIn:\s*false/);
    assert.match(cardOnFileFormSource, /currencyCode:\s*"CAD"/);
    assert.match(cardOnFileFormSource, /\/api\/booking\/card-on-file/);
  });

  it("card-on-file form passes verificationDetails directly to Square tokenize", async () => {
    const source = await readFile(
      new URL("./square-card-on-file-form.tsx", import.meta.url),
      "utf8",
    );

    assert.match(source, /cardRef\.current\.tokenize\(verificationDetails\)/);
    assert.doesNotMatch(source, /tokenize\(\{\s*verificationDetails\s*\}\)/);
  });

  it("requires policy acceptance before card-on-file submission", () => {
    assert.match(cardOnFileFormSource, /type="checkbox"/);
    assert.match(cardOnFileFormSource, /policy/i);
    assert.match(cardOnFileFormSource, /accepted/);
    assert.match(cardOnFileFormSource, /maxChargeCents/);
  });

  it("keeps the Square card container mounted while initializing", () => {
    assert.doesNotMatch(
      cardOnFileFormSource,
      /if \(isConfigLoading \|\| isInitializing\) \{[\s\S]*?return \(/,
    );
    assert.match(cardOnFileFormSource, /cardContainerId/);
    assert.match(
      cardOnFileFormSource,
      /await card\.attach\(`#\$\{cardContainerId\}`\)/,
    );

    const cardContainerIndex = cardOnFileFormSource.indexOf("cardContainerId");
    const earlyConfigNullReturn = cardOnFileFormSource.indexOf(
      "if (config === null) return null",
    );
    assert.ok(
      earlyConfigNullReturn === -1 ||
        cardContainerIndex < earlyConfigNullReturn,
      "card container must be rendered before any config-unavailable early return",
    );
  });

  it("renders the Square card container as a div or span, not a section", () => {
    const containerMatch = cardOnFileFormSource.match(
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
      cardOnFileFormSource,
      /try \{\s*await card\.attach\(`#\$\{cardContainerId\}`\);\s*\} catch \(attachError: unknown\) \{\s*card\.destroy\(\);\s*throw attachError;\s*\}/,
    );
  });

  it("starts legacy checkout at most once when Square config is unavailable", () => {
    assert.match(serviceBookingPaymentShellSource, /isStartingFallbackRef/);
    assert.match(
      serviceBookingPaymentShellSource,
      /if \(isStartingFallbackRef\.current\) return;/,
    );
    assert.match(serviceBookingPaymentShellSource, /isMountedRef\.current/);
  });

  it("does not nest a form inside the parent booking form", () => {
    assert.doesNotMatch(cardOnFileFormSource, /<form\b/);
    assert.doesNotMatch(cardOnFileFormSource, /<form\s/);
    assert.match(cardOnFileFormSource, /type="button"/);
    assert.doesNotMatch(cardOnFileFormSource, /type="submit"/);
  });

  it("does not expose Square identifiers or raw tokens in card-on-file UI", () => {
    assert.doesNotMatch(cardOnFileFormSource, /squareCardId/);
    assert.doesNotMatch(cardOnFileFormSource, /squareCustomerId/);
    assert.doesNotMatch(cardOnFileFormSource, /cnon:/);
    assert.doesNotMatch(cardOnFileFormSource, /squareInvoiceId/);
    assert.doesNotMatch(cardOnFileFormSource, /squareOrderId/);
  });

  it("keeps legacy Square checkout fallback exported for payment shell reuse", () => {
    assert.match(
      serviceBookingPaymentClientSource,
      /export async function startLegacySquareCheckout/,
    );
    assert.match(
      serviceBookingPaymentClientSource,
      /\("\/api\/booking\/checkout"/,
    );
  });

  it("fetches Square card-on-file config and returns null when disabled", async () => {
    const fetcher: typeof fetch = async (input) => {
      if (input.toString() === "/api/booking/square/config") {
        return Response.json(
          { error: "Square card-on-file booking is not enabled" },
          { status: 404 },
        );
      }

      return Response.json({ error: "Unexpected request" }, { status: 500 });
    };

    const config = await fetchSquareCardOnFileConfig(fetcher);

    assert.equal(config, null);
  });

  it("returns card-on-file config when enabled", async () => {
    const fetcher: typeof fetch = async (input) => {
      if (input.toString() === "/api/booking/square/config") {
        return Response.json({
          applicationId: "sq0idp-test",
          environment: "sandbox",
          locationId: "LTEST",
          scriptUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
        });
      }

      return Response.json({ error: "Unexpected request" }, { status: 500 });
    };

    const config = await fetchSquareCardOnFileConfig(fetcher);

    assert.deepEqual(config, {
      applicationId: "sq0idp-test",
      environment: "sandbox",
      locationId: "LTEST",
      scriptUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
    });
  });

  it("confirms card-on-file booking with a safe response only", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = input.toString();
      requests.push({ url, body: parseJsonBody(init?.body) });

      if (url === "/api/booking/card-on-file") {
        return Response.json({
          bookingStatus: "booked",
          card: { brand: "VISA", expMonth: 12, expYear: 2030, last4: "4242" },
          holdReference: "hold_public_1",
          noShowChargeStatus: "ready",
        });
      }

      return Response.json({ error: "Unexpected request" }, { status: 500 });
    };

    const result = await confirmCardOnFileBooking({
      paymentSessionReference: "pay_sess_test_1",
      cardholderName: "Client Name",
      sourceId: "cnon:card-token",
      verificationToken: "verf-token",
      policy: {
        accepted: true,
        maxChargeCents: 15000,
        policyTextHash: "policy-hash",
        policyVersion: "service-no-show-full-amount-v1",
      },
      idempotencyKey: "idem-key-1",
      fetcher,
    });

    assert.deepEqual(result, {
      bookingStatus: "booked",
      card: { brand: "VISA", expMonth: 12, expYear: 2030, last4: "4242" },
      holdReference: "hold_public_1",
      noShowChargeStatus: "ready",
    });
    assert.deepEqual(requests, [
      {
        url: "/api/booking/card-on-file",
        body: {
          paymentSessionReference: "pay_sess_test_1",
          cardholderName: "Client Name",
          sourceId: "cnon:card-token",
          verificationToken: "verf-token",
          policy: {
            accepted: true,
            maxChargeCents: 15000,
            policyTextHash: "policy-hash",
            policyVersion: "service-no-show-full-amount-v1",
          },
          idempotencyKey: "idem-key-1",
        },
      },
    ]);
  });

  it("surfaces expired holds during card-on-file confirmation", async () => {
    const fetcher: typeof fetch = async () => {
      return Response.json(
        { error: "Booking hold is no longer available" },
        { status: 409 },
      );
    };

    await assert.rejects(
      confirmCardOnFileBooking({
        paymentSessionReference: "pay_sess_test_1",
        cardholderName: "Client Name",
        sourceId: "cnon:card-token",
        verificationToken: "verf-token",
        policy: {
          accepted: true,
          maxChargeCents: 15000,
          policyTextHash: "policy-hash",
          policyVersion: "service-no-show-full-amount-v1",
        },
        idempotencyKey: "idem-key-1",
        fetcher,
      }),
      /Hold expired, choose another time\./,
    );
  });

  it("implements a promise-backed Square script loader with error cleanup", () => {
    assert.match(
      cardOnFileFormSource,
      /const scriptPromises = new Map<string, Promise<void>>/,
    );
    assert.match(cardOnFileFormSource, /scriptPromises\.get\(scriptUrl\)/);
    assert.match(
      cardOnFileFormSource,
      /scriptPromises\.set\(scriptUrl, promise\)/,
    );
    assert.match(cardOnFileFormSource, /scriptPromises\.delete\(scriptUrl\)/);
    assert.match(cardOnFileFormSource, /script\.remove\(\)/);
    assert.match(cardOnFileFormSource, /export function loadSquareScript/);
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

  it("starts legacy Square checkout as fallback when card-on-file is unavailable", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = input.toString();
      requests.push({ url, body: parseJsonBody(init?.body) });

      if (url === "/api/booking/checkout") {
        return Response.json({
          checkoutUrl: "https://square.link/u/fallback",
          holdReference: "hold_public_fallback",
          orderId: "lh-fallback-1",
          paymentProvider: "square",
          reused: true,
        });
      }

      return Response.json({ error: "Unexpected request" }, { status: 500 });
    };

    const checkout = await startLegacySquareCheckout(
      "pay_sess_fallback_1",
      fetcher,
    );

    assert.equal(checkout.checkoutUrl, "https://square.link/u/fallback");
    assert.equal(checkout.holdReference, "hold_public_fallback");
    assert.equal(checkout.reused, true);
    assert.deepEqual(requests, [
      {
        url: "/api/booking/checkout",
        body: { paymentSessionReference: "pay_sess_fallback_1" },
      },
    ]);
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
