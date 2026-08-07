import assert from "node:assert/strict";
import test from "node:test";

import {
  createGrantEntitlementCommand,
  createRevokeEntitlementCommand,
  hashEntitlementPayload,
  stableSerialize,
} from "./entitlement-commands";

test("grant commands use the stable item/user key and preserve their timestamp", () => {
  const command = createGrantEntitlementCommand({
    courseId: "11111111-1111-4111-8111-111111111111",
    courseOrderItemId: "item-1",
    externalPaymentId: "transaction-1",
    grantedAt: "2026-08-07T10:11:12.345Z",
    orderId: "order-1",
    provider: "helcim",
    userId: "user-1",
  });

  assert.deepEqual(command, {
    userId: "user-1",
    courseId: "11111111-1111-4111-8111-111111111111",
    orderId: "order-1",
    externalPaymentId: "transaction-1",
    provider: "helcim",
    idempotencyKey: "course-entitlement:grant:v1:item-1:user-1",
    grantReason: "purchase",
    grantedAt: "2026-08-07T10:11:12.345Z",
    expiresAt: null,
  });
  assert.equal(Object.isFrozen(command), true);
});

test("revoke commands use a separate stable key namespace", () => {
  const command = createRevokeEntitlementCommand({
    courseId: "11111111-1111-4111-8111-111111111111",
    courseOrderItemId: "item-1",
    orderId: "order-1",
    revokedAt: new Date("2026-08-08T10:11:12.345Z"),
    revokeReason: "refund",
    userId: "user-1",
  });

  assert.equal(
    command.idempotencyKey,
    "course-entitlement:revoke:v1:item-1:user-1",
  );
  assert.equal(command.revokedAt, "2026-08-08T10:11:12.345Z");
});

test("payload hashing is stable across object property order", () => {
  const first = {
    userId: "user-1",
    courseId: "course-1",
    orderId: "order-1",
    idempotencyKey: "key-1",
    grantReason: "purchase" as const,
    grantedAt: "2026-08-07T10:11:12.345Z",
    expiresAt: null,
  };
  const second = {
    expiresAt: null,
    grantedAt: "2026-08-07T10:11:12.345Z",
    grantReason: "purchase" as const,
    idempotencyKey: "key-1",
    orderId: "order-1",
    courseId: "course-1",
    userId: "user-1",
  };

  assert.equal(stableSerialize(first), stableSerialize(second));
  assert.equal(hashEntitlementPayload(first), hashEntitlementPayload(second));
  assert.match(hashEntitlementPayload(first), /^[a-f0-9]{64}$/);
});
