import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateDiscountedCustomsValues,
  splitCustomsLineValue,
} from "./customs";

test("customs allocation uses deterministic largest remainders and exact cents", () => {
  const allocated = allocateDiscountedCustomsValues(
    [
      { key: "a", quantity: 1, merchandiseTotalCents: 1000 },
      { key: "b", quantity: 1, merchandiseTotalCents: 1000 },
      { key: "c", quantity: 1, merchandiseTotalCents: 1000 },
    ],
    2000,
  );
  assert.deepEqual(
    [...allocated.entries()],
    [
      ["a", 667],
      ["b", 667],
      ["c", 666],
    ],
  );
  assert.equal(
    [...allocated.values()].reduce((sum, value) => sum + value, 0),
    2000,
  );
});

test("customs unit splitting preserves the allocated total", () => {
  assert.deepEqual(splitCustomsLineValue(1000, 3), [334, 333, 333]);
  assert.throws(() => splitCustomsLineValue(2, 3), /at least one cent/);
});
