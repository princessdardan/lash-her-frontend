import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LOW_STOCK_THRESHOLD, stockStatusFor } from "./product-stock-status";

describe("stockStatusFor", () => {
  it("treats null/undefined available as untracked (unlimited)", () => {
    assert.equal(stockStatusFor(null), "untracked");
    assert.equal(stockStatusFor(undefined), "untracked");
  });

  it("reports sold out at zero or below", () => {
    assert.equal(stockStatusFor(0), "sold_out");
    assert.equal(stockStatusFor(-3), "sold_out");
  });

  it("reports low stock at or below the threshold", () => {
    assert.equal(stockStatusFor(1), "low_stock");
    assert.equal(stockStatusFor(LOW_STOCK_THRESHOLD), "low_stock");
  });

  it("reports in stock above the threshold", () => {
    assert.equal(stockStatusFor(LOW_STOCK_THRESHOLD + 1), "in_stock");
    assert.equal(stockStatusFor(999), "in_stock");
  });

  it("honors a custom threshold", () => {
    assert.equal(stockStatusFor(10, 20), "low_stock");
    assert.equal(stockStatusFor(21, 20), "in_stock");
  });
});
