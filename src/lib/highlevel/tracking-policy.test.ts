import assert from "node:assert/strict";
import test from "node:test";
import {
  highLevelTrackingStatus,
  isApprovedHighLevelTrackingUrl,
} from "./tracking-policy";

test("tracking defaults off and remains blocked even when the independent flag is requested", () => {
  for (const flag of [undefined, "false", "1", "true"]) {
    assert.deepEqual(highLevelTrackingStatus(flag), {
      requested: flag === "true",
      enabled: false,
      reason: "vendor_verification_required",
    });
  }
});
test("only explicitly reviewed public paths qualify as future tracking candidates", () => {
  for (const path of [
    "/",
    "/gallery",
    "/services",
    "/products",
    "/training-programs",
  ])
    assert.equal(
      isApprovedHighLevelTrackingUrl(`https://lashher.com${path}`),
      true,
    );
  for (const path of [
    "/admin",
    "/studio",
    "/api",
    "/auth",
    "/login",
    "/checkout",
    "/products/confirmation",
    "/booking",
    "/booking/confirmation",
    "/services/lashes/booking/payment",
    "/training-programs/lashes/checkout",
    "/training-programs/lashes/confirmation",
    "/training-programs/lashes/schedule",
    "/courses/private",
    "/access/token",
    "/contact",
    "/policies/privacy",
    "/new-page",
    "/gallery/extra",
  ])
    assert.equal(
      isApprovedHighLevelTrackingUrl(`https://lashher.com${path}`),
      false,
      path,
    );
});
test("raw queries, fragments, credentials, encoded paths, other hosts and protocols fail closed", () => {
  for (const value of [
    "https://lashher.com/?token=private",
    "https://lashher.com/?utm_source=person%40example.com",
    "https://lashher.com/?_rsc=x",
    "https://lashher.com/#private",
    "https://user:pass@lashher.com/",
    "https://lashher.com:444/",
    "https://evil.test/",
    "https://lashher.com.evil.test/",
    "http://lashher.com/",
    "https://lashher.com/%67allery",
    "//lashher.com/",
    "/",
    "bad url",
  ])
    assert.equal(isApprovedHighLevelTrackingUrl(value), false, value);
});
