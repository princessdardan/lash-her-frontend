import assert from "node:assert/strict";
import test from "node:test";
import {
  computeShipmentRetryDelaySeconds,
  hashOperationPayload,
  MAX_SHIPMENT_OPERATION_ATTEMPTS,
} from "./shipment-store";

test("operation payload hashes are stable and distinguish semantic changes", () => {
  assert.equal(
    hashOperationPayload({ shipmentId: "1", payload: { b: 2, a: 1 } }),
    hashOperationPayload({ payload: { a: 1, b: 2 }, shipmentId: "1" }),
  );
  assert.notEqual(
    hashOperationPayload({ expectedShipmentStateVersion: 2 }),
    hashOperationPayload({ expectedShipmentStateVersion: 3 }),
  );
});

test("retry delay is capped exponential jitter and honors Retry-After", () => {
  assert.equal(
    computeShipmentRetryDelaySeconds({ attemptCount: 1, jitter: 0 }),
    30,
  );
  assert.equal(
    computeShipmentRetryDelaySeconds({ attemptCount: 4, jitter: 0 }),
    240,
  );
  assert.equal(
    computeShipmentRetryDelaySeconds({
      attemptCount: 2,
      retryAfterSeconds: 900,
      jitter: 0,
    }),
    900,
  );
  assert.equal(
    computeShipmentRetryDelaySeconds({
      attemptCount: MAX_SHIPMENT_OPERATION_ATTEMPTS + 100,
      retryAfterSeconds: 100_000,
      jitter: 1,
    }),
    86_400,
  );
});
