import assert from "node:assert/strict";
import test from "node:test";
import { observeFrontendSquareEffects } from "./frontend-square-effects.mjs";
import { frontendCoordinationHash as hash } from "./frontend-release-inventory.mjs";

const recordId = "11111111-1111-4111-8111-111111111111";
const expected = { recordKind: "booking-payment-attempt", recordId, databaseStatus: "pending", idempotencySha256: hash("original-key"), providerKind: "payment",
  providerId: null, amountCents: 100, currency: "CAD", providerOrderId: null, referenceId: "public-ref" };
const reviewed = () => ({ environment: "sandbox", locationId: "LE2H76M5V90AM", effects: [{ recordKind: "booking-payment-attempt", recordId, databaseRowSha256: hash(expected) }] });
function database(change = {}) {
  const calls = [], row = { id: recordId, status: "pending", payment_provider: "square", operation: "square_charge_and_store", idempotency_key: "original-key",
    provider_payment_id: null, provider_order_id: null, amount_cents: 100, currency: "CAD", reference_id: "public-ref", ...change };
  const client = { async query(sql, values) { calls.push({ sql, values }); return { rows: sql.startsWith("SELECT a.id") ? [row] : [] }; } };
  return { client, calls };
}

test("actual DB rows bind original idempotency without replay, preserve missing IDs and use readonly transaction", async () => {
  const f = database(); let verifications = 0;
  const rows = await observeFrontendSquareEffects(f.client, reviewed(), async () => { verifications++; });
  assert.deepEqual(rows, [{ ...expected, databaseRowSha256: hash(expected) }]); assert.equal(verifications, 3);
  assert.equal(f.calls[0].sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); assert.equal(f.calls.at(-1).sql, "COMMIT");
  assert.ok(!/customer|email|card|provider_metadata|INSERT|UPDATE|DELETE/u.test(f.calls[1].sql));
  assert.ok(!JSON.stringify(rows).includes("original-key"));
});

test("changed financial rows or foreign provider refuse and rollback without returning an effect certificate", async () => {
  for (const change of [{ idempotency_key: "changed" }, { amount_cents: 200 }, { payment_provider: "helcim" }, { operation: "unknown" }, { currency: "USD" }]) {
    const f = database(change);
    await assert.rejects(observeFrontendSquareEffects(f.client, reviewed(), async () => {}), /FRONTEND_SQUARE_DATABASE_EFFECTS_REFUSED/u);
    assert.equal(f.calls.at(-1).sql, "ROLLBACK"); assert.ok(f.calls.every(row => !/^(INSERT|UPDATE|DELETE)/u.test(row.sql)));
  }
});
