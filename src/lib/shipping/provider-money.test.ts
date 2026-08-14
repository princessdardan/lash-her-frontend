import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderMoneyCents } from "./provider-money";

test("provider money is parsed exactly into cents", () => {
  assert.equal(parseProviderMoneyCents("0"), 0);
  assert.equal(parseProviderMoneyCents("12.3"), 1230);
  assert.equal(parseProviderMoneyCents("12.34"), 1234);
  assert.equal(parseProviderMoneyCents(12.34), 1234);
  assert.equal(parseProviderMoneyCents(null), null);
});

test("provider money rejects ambiguous or invalid accounting values", () => {
  for (const value of ["-1", "1.234", "NaN", "Infinity", "1e3", " 1.00x"]) {
    assert.throws(() => parseProviderMoneyCents(value));
  }
});
