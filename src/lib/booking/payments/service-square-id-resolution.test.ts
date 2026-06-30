import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySquareReturnOrderId,
  isLocalServiceBookingOrderId,
} from "./service-square-id-resolution";

test("detects Lash Her local Square service order ids", () => {
  assert.equal(isLocalServiceBookingOrderId("lh-sq-abc123"), true);
  assert.equal(isLocalServiceBookingOrderId(" LH-SQ-abc123 "), false);
  assert.equal(isLocalServiceBookingOrderId("square-order-123"), false);
  assert.equal(isLocalServiceBookingOrderId(undefined), false);
});

test("classifies return order identifiers without treating local ids as provider ids", () => {
  assert.deepEqual(classifySquareReturnOrderId("lh-sq-local-1"), {
    localOrderId: "lh-sq-local-1",
    providerOrderId: undefined,
  });

  assert.deepEqual(classifySquareReturnOrderId("square-order-1"), {
    localOrderId: undefined,
    providerOrderId: "square-order-1",
  });

  assert.deepEqual(classifySquareReturnOrderId(undefined), {
    localOrderId: undefined,
    providerOrderId: undefined,
  });
});
