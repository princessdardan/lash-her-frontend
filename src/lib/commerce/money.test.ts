import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addCad, formatCad, multiplyCad, parseCad } from "./money";

describe("commerce money helpers", () => {
  it("parses valid CAD amounts from numbers and strings", () => {
    assert.equal(parseCad(125.5), 125.5);
    assert.equal(parseCad("125.50"), 125.5);
  });

  it("rejects negative values", () => {
    assert.throws(() => parseCad(-1), /valid CAD amount/);
  });

  it("rejects over-precise values", () => {
    assert.throws(() => parseCad("12.345"), /valid CAD amount/);
  });

  it("adds CAD amounts without floating point drift", () => {
    assert.equal(addCad([10.1, 2.2, 0.7]), 13);
  });

  it("multiplies CAD amounts without floating point drift", () => {
    assert.equal(multiplyCad(19.99, 3), 59.97);
  });

  it("formats CAD amounts", () => {
    assert.equal(formatCad(59.97), "$59.97 CAD");
  });
});
