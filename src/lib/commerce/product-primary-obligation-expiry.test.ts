import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("automated primary payment obligation freezes the shipping quote expiry", () => {
  const source = readFileSync(
    new URL("./order-store.ts", import.meta.url),
    "utf8",
  );
  const automatedReservation = source.slice(
    source.indexOf('sourceWorkflow: "automated_product_checkout"'),
    source.indexOf(
      "export async function createInitializingManualProductOrder",
    ),
  );
  assert.match(automatedReservation, /expiresAt:\s*quote\.quoteExpiresAt/);
});
