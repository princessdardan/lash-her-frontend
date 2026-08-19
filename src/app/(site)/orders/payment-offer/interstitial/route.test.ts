import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { GET } from "./route";

test("payment offer interstitial is query-free, no-store, and never renders the bearer", async () => {
  const bearer = "customer-bearer-must-not-render";
  const response = GET(
    new NextRequest("https://lashher.test/orders/payment-offer/interstitial", {
      headers: {
        cookie: `lh_supplemental_payment_offer_bearer=${bearer}`,
      },
    }),
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /action="\/orders\/payment-offer\/exchange"/);
  assert.doesNotMatch(body, /name="token"/);
  assert.doesNotMatch(body, new RegExp(bearer));
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /form-action 'self'/,
  );
});

test("payment offer interstitial fails closed without the bearer cookie", () => {
  const response = GET(
    new NextRequest("https://lashher.test/orders/payment-offer/interstitial"),
  );
  assert.equal(response.status, 404);
});
