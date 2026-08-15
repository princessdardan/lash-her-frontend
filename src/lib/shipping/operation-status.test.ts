import assert from "node:assert/strict";
import test from "node:test";

import { isTerminalShipmentOperationStatus } from "./operation-status";

test("only completed or dead-lettered shipment operations are terminal", () => {
  assert.equal(isTerminalShipmentOperationStatus("queued"), false);
  assert.equal(isTerminalShipmentOperationStatus("processing"), false);
  assert.equal(isTerminalShipmentOperationStatus("retryable_failed"), false);
  assert.equal(isTerminalShipmentOperationStatus("succeeded"), true);
  assert.equal(isTerminalShipmentOperationStatus("dead_letter"), true);
});
