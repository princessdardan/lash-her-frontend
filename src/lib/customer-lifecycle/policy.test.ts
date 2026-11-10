import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { AccountLifecycleError, assertFreshCustomerSession, parseAccountCommand, parseAccountRequest } from "./policy";

test("account requests are closed, canonical, and limited to the published actions", () => {
  const idempotencyKey = randomUUID();
  assert.deepEqual(parseAccountRequest({ action: "delete", idempotencyKey }), { action: "delete", idempotencyKey });
  for (const input of [null, [], {}, { action: "delete", idempotencyKey, email: "private@example.com" }, { action: "delete", idempotencyKey: idempotencyKey.toUpperCase() }, { action: "erase", idempotencyKey }]) assert.throws(() => parseAccountRequest(input), AccountLifecycleError);
});
test("fresh authentication is bounded, does not accept future or invalid session timestamps", () => {
  const now = new Date();
  assertFreshCustomerSession(new Date(now.getTime() - 900_000), now);
  for (const timestamp of [now.getTime() - 900_001, now.getTime() + 1, NaN]) assert.throws(() => assertFreshCustomerSession(new Date(timestamp), now), /fresh_sign_in_required/u);
});
test("published lifecycle commands reject PII and unsafe sequence versions", () => {
  const command = { version: 1, commandId: randomUUID(), userId: randomUUID(), accountVersion: Number.MAX_SAFE_INTEGER, action: "export", issuedAt: new Date().toISOString() };
  assert.deepEqual(parseAccountCommand(command), command);
  assert.throws(() => parseAccountCommand({ ...command, accountVersion: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => parseAccountCommand({ ...command, email: "private@example.com" }));
});
