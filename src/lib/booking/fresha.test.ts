import assert from "node:assert/strict";
import test from "node:test";
import {
  FRESHA_BOOKING_URL,
  isServiceBookingEntryHref,
  withFreshaBookingLinks,
} from "./fresha";
import {
  GET,
  POST as availabilityPost,
} from "@/app/api/booking/availability/route";
import { POST as holdsPost } from "@/app/api/booking/holds/route";
import { POST as createPost } from "@/app/api/booking/create/route";

test("exported reservation endpoints are closed independently of all payment/model flags", async (t) => {
  const keys = [
    "SERVICE_BOOKING_MODEL_MODE",
    "SERVICE_BOOKING_SQUARE_ENABLED",
    "SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED",
    "DATABASE_URL",
  ];
  const saved = keys.map((key) => [key, process.env[key]] as const);
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const mode of ["legacy", "dual", "operational"]) {
    for (const enabled of ["true", "false"]) {
      process.env.SERVICE_BOOKING_MODEL_MODE = mode;
      process.env.SERVICE_BOOKING_SQUARE_ENABLED = enabled;
      process.env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED = enabled;
      process.env.DATABASE_URL = "postgres://invalid.invalid/do-not-connect";
      const providerCalls: unknown[] = [];
      t.mock.method(
        globalThis,
        "fetch",
        async (...args: Parameters<typeof fetch>) => {
          providerCalls.push(args);
          throw new Error("Unexpected provider call");
        },
      );
      for (const handler of [GET, availabilityPost, holdsPost, createPost]) {
        const request = new Request("https://lashher.com/api/booking/holds", {
          method: "POST",
          body: "{invalid json",
        });
        const response = await handler(request);
        assert.equal(response.status, 410);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), {
          code: "SERVICE_BOOKING_MOVED",
          error:
            "New service bookings are now managed on Fresha. Existing bookings remain valid.",
          bookingUrl: FRESHA_BOOKING_URL,
        });
        assert.equal(request.bodyUsed, false);
      }
      assert.deepEqual(providerCalls, []);
      t.mock.restoreAll();
    }
  }
});

test("only service entry URLs are rewritten, with all private parameters discarded", () => {
  for (const href of [
    "/booking?email=private@example.test",
    "/services/lashes/booking/?session=private#secret",
    "https://lashher.com/booking",
    "https://www.lashher.com/booking",
    FRESHA_BOOKING_URL + "/all-offer?menu=true",
  ]) {
    assert.equal(isServiceBookingEntryHref(href), true);
    assert.deepEqual(
      withFreshaBookingLinks({ href, label: "Book", isExternal: false }),
      { href: FRESHA_BOOKING_URL, label: "Book on Fresha", isExternal: true },
    );
  }
  for (const href of [
    "/services",
    "/services/lashes",
    "/booking/confirmation?order=private",
    "/services/lashes/booking/payment?session=private",
    "/services/lashes/booking/confirmation",
    "/training-programs/lashes/schedule?token=private",
    "/products/lashes",
    "https://example.com/booking",
    "//example.com/booking",
    "javascript:alert(1)",
  ]) {
    assert.equal(isServiceBookingEntryHref(href), false);
    const input = { href, label: "Original" };
    assert.deepEqual(withFreshaBookingLinks(input), input);
  }
});

test("nested CMS navigation and CTA links are normalized without mutation", () => {
  const input = {
    menu: [{ title: "Appointments", url: "/booking", linkType: "direct" }],
    hero: { links: [{ href: "/services/lashes/booking", label: "Reserve" }] },
    product: { href: "/products/serum", label: "Buy" },
  };
  const snapshot = structuredClone(input);
  const output = withFreshaBookingLinks(input);
  assert.equal(output.menu[0].url, FRESHA_BOOKING_URL);
  assert.equal(output.menu[0].linkType, "external");
  assert.equal(output.hero.links[0].label, "Book on Fresha");
  assert.deepEqual(output.product, input.product);
  assert.deepEqual(input, snapshot);
});

test("booking CTAs to the catalog are rewritten while ordinary services navigation survives", () => {
  assert.deepEqual(
    withFreshaBookingLinks({
      href: "https://lashher.com/services",
      label: "Book Now",
    }),
    { href: FRESHA_BOOKING_URL, label: "Book on Fresha" },
  );
  assert.deepEqual(
    withFreshaBookingLinks({ url: "/services", title: "Services" }),
    { url: "/services", title: "Services" },
  );
  assert.deepEqual(
    withFreshaBookingLinks({ href: "/training-programs", label: "Book Now" }),
    { href: "/training-programs", label: "Book Now" },
  );
});
