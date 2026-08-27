import assert from "node:assert/strict";
import test from "node:test";

import {
  CHITCHATS_REGIONS,
  getChitChatsOperationalIdentity,
  getProductCheckoutAvailability,
  parseChitChatsRegion,
} from "./config";

test("accepts only the canonical Chit Chats regions", () => {
  for (const region of CHITCHATS_REGIONS) {
    assert.equal(parseChitChatsRegion(region), region);
  }
  assert.equal(
    parseChitChatsRegion("  ontario_manitoba  "),
    "ontario_manitoba",
  );
  assert.throws(() => parseChitChatsRegion("ontario"), /must be one of/);
});

test("operational identity keeps region out of provider credentials", () => {
  const previous = {
    clientId: process.env.CHITCHATS_CLIENT_ID,
    environment: process.env.CHITCHATS_ENVIRONMENT,
    region: process.env.CHITCHATS_REGION,
    vercelEnvironment: process.env.VERCEL_ENV,
  };
  try {
    process.env.CHITCHATS_CLIENT_ID = "123456";
    process.env.CHITCHATS_ENVIRONMENT = "staging";
    process.env.CHITCHATS_REGION = "ontario_manitoba";
    process.env.VERCEL_ENV = "preview";
    assert.deepEqual(getChitChatsOperationalIdentity(), {
      clientId: "123456",
      environment: "staging",
      region: "ontario_manitoba",
    });
  } finally {
    restore("CHITCHATS_CLIENT_ID", previous.clientId);
    restore("CHITCHATS_ENVIRONMENT", previous.environment);
    restore("CHITCHATS_REGION", previous.region);
    restore("VERCEL_ENV", previous.vercelEnvironment);
  }
});

test("product checkout availability requires Square commerce for both modes", () => {
  const keys = [
    "SQUARE_COMMERCE_ENABLED",
    "CHITCHATS_SHIPPING_ENABLED",
    "CHITCHATS_CHECKOUT_ENABLED",
    "MANUAL_PRODUCT_CHECKOUT_ENABLED",
  ] as const;
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const set = (values: Partial<Record<(typeof keys)[number], string>>) => {
    for (const k of keys) restore(k, values[k]);
  };
  try {
    // Every flag on -> both modes available.
    set({
      SQUARE_COMMERCE_ENABLED: "true",
      CHITCHATS_SHIPPING_ENABLED: "true",
      CHITCHATS_CHECKOUT_ENABLED: "true",
      MANUAL_PRODUCT_CHECKOUT_ENABLED: "true",
    });
    assert.deepEqual(getProductCheckoutAvailability(), {
      automated: true,
      manual: true,
    });

    // Square off disables BOTH modes even though the fulfillment flags are on:
    // both charge through Square, so the buy button must not look active.
    set({
      SQUARE_COMMERCE_ENABLED: "false",
      CHITCHATS_SHIPPING_ENABLED: "true",
      CHITCHATS_CHECKOUT_ENABLED: "true",
      MANUAL_PRODUCT_CHECKOUT_ENABLED: "true",
    });
    assert.deepEqual(getProductCheckoutAvailability(), {
      automated: false,
      manual: false,
    });

    // Square on but Chit Chats off -> only manual pickup is available.
    set({
      SQUARE_COMMERCE_ENABLED: "true",
      CHITCHATS_SHIPPING_ENABLED: "false",
      CHITCHATS_CHECKOUT_ENABLED: "false",
      MANUAL_PRODUCT_CHECKOUT_ENABLED: "true",
    });
    assert.deepEqual(getProductCheckoutAvailability(), {
      automated: false,
      manual: true,
    });
  } finally {
    for (const k of keys) restore(k, previous[k]);
  }
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
