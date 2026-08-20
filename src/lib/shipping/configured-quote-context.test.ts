import assert from "node:assert/strict";
import test from "node:test";

import { buildConfiguredQuoteContext } from "./configured-quote-context";
import {
  bindShippingFingerprintToContext,
  parseShippingQuoteContextSnapshot,
} from "./quote-token";

const now = new Date("2026-08-17T00:00:00Z");

test("configured quote context passes the real snapshot parser for CA and US", () => {
  for (const destinationCountryCode of ["CA", "US"] as const) {
    const context = buildConfiguredQuoteContext({
      destinationCountryCode,
      region: "ontario_manitoba",
      usShippingContract: null,
      now,
    });
    const parsed = parseShippingQuoteContextSnapshot(
      JSON.parse(JSON.stringify(context)),
    );
    assert.ok(
      parsed,
      `${destinationCountryCode} context must pass parseShippingQuoteContextSnapshot`,
    );
    assert.ok(
      context.servicePolicies.length > 0,
      `${destinationCountryCode} must have at least one service policy`,
    );
    assert.ok(
      context.servicePolicies.every(
        (service) => service.destinationCountryCode === destinationCountryCode,
      ),
      "service policies must match the destination",
    );
    assert.ok(context.shippingPolicySnapshot.closureDates.length > 0);
  }
});

test("fingerprint binding is deterministic for identical config inputs", () => {
  const build = () =>
    buildConfiguredQuoteContext({
      destinationCountryCode: "CA",
      region: "ontario_manitoba",
      now,
    });
  assert.equal(
    bindShippingFingerprintToContext("fp", build()),
    bindShippingFingerprintToContext("fp", build()),
  );
});
