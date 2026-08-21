import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import test from "node:test";

// order-store.ts is `server-only`, so (like order-store.test.ts) the exported
// helpers are exercised in a child `tsx` process under the react-server
// condition, where the `server-only` import resolves to an empty module.
const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    deriveDeterministicOrderId,
    assertReusedReservationMatches,
  } from "./src/lib/commerce/order-store.ts";
`;

test("same reservationKey derives the same deterministic orderId (retry reuses one order)", () => {
  // A retry of the same attempt (lost HTTP response -> re-click "Pay securely")
  // sends the same reservationKey, so the derived orderId is identical. That
  // identical orderId feeds the unique-constrained reservation insert
  // (onConflictDoNothing) and the Square idempotency key, yielding a single
  // order and a single charge instead of two.
  runReservationScenario(String.raw`
    const key = "b1e5f6a2-4c3d-4e2f-8a1b-9c0d1e2f3a4b";
    const first = deriveDeterministicOrderId(key);
    const second = deriveDeterministicOrderId(key);
    assert.equal(first, second);
    assert.match(first, /^lh-[A-Za-z0-9_-]{12}$/);
  `);
});

test("distinct reservationKeys derive distinct orderIds", () => {
  runReservationScenario(String.raw`
    const ids = new Set();
    for (let i = 0; i < 500; i += 1) {
      ids.add(deriveDeterministicOrderId("attempt-" + i));
    }
    assert.equal(ids.size, 500);
  `);
});

test("assertReusedReservationMatches accepts a reused order for the same customer + purpose", () => {
  runReservationScenario(String.raw`
    assert.doesNotThrow(() =>
      assertReusedReservationMatches(
        { customerEmail: "student@example.com", purpose: "training" },
        { customerEmail: "student@example.com", purpose: "training" },
      ),
    );
  `);
});

test("assertReusedReservationMatches rejects a hash collision across customers or purposes", () => {
  runReservationScenario(String.raw`
    assert.throws(
      () =>
        assertReusedReservationMatches(
          { customerEmail: "someone-else@example.com", purpose: "training" },
          { customerEmail: "student@example.com", purpose: "training" },
        ),
      /Reservation key does not match the existing order/,
    );
    assert.throws(
      () =>
        assertReusedReservationMatches(
          { customerEmail: "student@example.com", purpose: "product" },
          { customerEmail: "student@example.com", purpose: "training" },
        ),
      /Reservation key does not match the existing order/,
    );
  `);
});

function runReservationScenario(assertions: string): void {
  const scenario = `${helperScript}\n${assertions}`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  env.CHECKOUT_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
