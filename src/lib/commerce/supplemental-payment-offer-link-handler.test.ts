import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { createSupplementalPaymentOfferLinkHandlers } from "./supplemental-payment-offer-link-handler";
import { buildSupplementalPaymentOfferLink } from "./supplemental-payment-offers";

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    assertMutationAllowed: () => undefined,
    checkBlocked: async () => false,
    checkRateLimit: async () => ({ allowed: true as const, remaining: 4 }),
    exchange: async () => "authenticated-session-token",
    recordFailure: async () => undefined,
    validateBearer: async () => true,
    ...overrides,
  };
}

function request(
  path: string,
  init: ConstructorParameters<typeof NextRequest>[1] = {},
): NextRequest {
  return new NextRequest(`https://lashher.test${path}`, {
    ...init,
    headers: {
      "x-forwarded-for": "203.0.113.20",
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  });
}

test("supplemental payment emails target the dedicated bearer bootstrap route", () => {
  const link = new URL(
    buildSupplementalPaymentOfferLink(
      "https://lashher.test/ignored/path",
      "customer-bearer-secret",
    ),
  );
  assert.equal(link.origin, "https://lashher.test");
  assert.equal(link.pathname, "/orders/payment-offer/exchange");
  assert.equal(link.searchParams.get("token"), "customer-bearer-secret");
});

test("payment offer GET moves the bearer into a short-lived HttpOnly cookie and query-free interstitial", async () => {
  const rateKeys: string[] = [];
  const handlers = createSupplementalPaymentOfferLinkHandlers(
    dependencies({
      checkRateLimit: async ({ key }: { key: string }) => {
        rateKeys.push(key);
        return { allowed: true as const, remaining: 4 };
      },
    }),
  );
  const response = await handlers.GET(
    request("/orders/payment-offer/exchange?token=customer-bearer-secret"),
  );

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "https://lashher.test/orders/payment-offer/interstitial",
  );
  assert.doesNotMatch(response.headers.get("location") ?? "", /token|secret/i);
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /lh_supplemental_payment_offer_bearer=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Max-Age=300/i);
  assert.match(cookie, /Path=\/orders\/payment-offer/i);
  assert.equal(rateKeys.length, 2, "subject and IP-wide limits both run");
  assert.notEqual(rateKeys[0], rateKeys[1]);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

test("payment offer POST exchanges only the bearer cookie and clears it", async () => {
  const exchanged: string[] = [];
  const rateKeys: string[] = [];
  const handlers = createSupplementalPaymentOfferLinkHandlers(
    dependencies({
      checkRateLimit: async ({ key }: { key: string }) => {
        rateKeys.push(key);
        return { allowed: true as const, remaining: 4 };
      },
      exchange: async (bearer: string) => {
        exchanged.push(bearer);
        return "authenticated-session-token";
      },
    }),
  );
  const response = await handlers.POST(
    request("/orders/payment-offer/exchange", {
      method: "POST",
      headers: {
        cookie: "lh_supplemental_payment_offer_bearer=customer-bearer-secret",
        origin: "https://lashher.test",
      },
    }),
  );

  assert.equal(response.status, 303);
  assert.deepEqual(exchanged, ["customer-bearer-secret"]);
  assert.equal(rateKeys.length, 2, "subject and IP-wide limits both run");
  assert.notEqual(rateKeys[0], rateKeys[1]);
  assert.equal(
    response.headers.get("location"),
    "https://lashher.test/orders/payment-offer",
  );
  const cookies = response.headers.get("set-cookie") ?? "";
  assert.match(cookies, /lh_supplemental_payment_offer=/);
  assert.match(cookies, /lh_supplemental_payment_offer_bearer=/);
  assert.match(cookies, /Max-Age=0/i);
  assert.doesNotMatch(cookies, /customer-bearer-secret/);
});

test("payment offer GET and POST failures count toward the global breaker", async () => {
  let failures = 0;
  const handlers = createSupplementalPaymentOfferLinkHandlers(
    dependencies({
      recordFailure: async () => {
        failures += 1;
      },
      validateBearer: async () => false,
    }),
  );

  const getResponse = await handlers.GET(
    request("/orders/payment-offer/exchange?token=invalid"),
  );
  const postResponse = await handlers.POST(
    request("/orders/payment-offer/exchange", {
      method: "POST",
      headers: { origin: "https://attacker.invalid" },
    }),
  );

  assert.equal(getResponse.status, 404);
  assert.equal(postResponse.status, 404);
  assert.equal(failures, 2);
});

test("payment offer global breaker blocks new GET and POST exchanges", async () => {
  let validated = 0;
  let exchanged = 0;
  const handlers = createSupplementalPaymentOfferLinkHandlers(
    dependencies({
      checkBlocked: async () => true,
      exchange: async () => {
        exchanged += 1;
        return "unexpected";
      },
      validateBearer: async () => {
        validated += 1;
        return true;
      },
    }),
  );

  assert.equal(
    (await handlers.GET(request("/orders/payment-offer/exchange?token=valid")))
      .status,
    404,
  );
  assert.equal(
    (
      await handlers.POST(
        request("/orders/payment-offer/exchange", {
          method: "POST",
          headers: {
            cookie: "lh_supplemental_payment_offer_bearer=valid",
            origin: "https://lashher.test",
          },
        }),
      )
    ).status,
    404,
  );
  assert.equal(validated, 0);
  assert.equal(exchanged, 0);
});
