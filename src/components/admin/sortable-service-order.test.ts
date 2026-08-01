import assert from "node:assert/strict";
import test from "node:test";

import { moveSortableItem } from "./sortable-service-order";

test("moves a service to a later display position", () => {
  assert.deepEqual(moveSortableItem(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
});

test("moves a service to an earlier display position", () => {
  assert.deepEqual(moveSortableItem(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
});

test("returns the original order for an invalid or unchanged move", () => {
  const items = ["a", "b"];
  assert.equal(moveSortableItem(items, -1, 0), items);
  assert.equal(moveSortableItem(items, 0, 0), items);
  assert.equal(moveSortableItem(items, 0, 2), items);
});
