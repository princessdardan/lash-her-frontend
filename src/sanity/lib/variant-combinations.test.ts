import assert from "node:assert";
import { describe, it } from "node:test";

import {
  buildSelectValue,
  deriveVariantAxes,
  enumerateCombinations,
  MAX_VARIANT_COMBINATIONS,
  overrideSelectionFingerprint,
  selectionFingerprint,
} from "./variant-combinations";

describe("variant combinations", () => {
  it("derives cleaned axes from authored options", () => {
    const axes = deriveVariantAxes([
      { name: " Curl ", values: ["C", "CC"] },
      { name: "Length", values: ["8mm", "9mm"] },
    ]);

    assert.deepStrictEqual(
      axes.map((axis) => axis.name),
      ["Curl", "Length"],
    );
    assert.deepStrictEqual(
      axes[0].choices.map((choice) => choice.value),
      ["C", "CC"],
    );
    // A stable, deterministic axis key is produced for writing selection keys.
    assert.match(axes[0].key, /^axis_/);
  });

  it("treats missing, empty, or malformed options as no axes", () => {
    assert.deepStrictEqual(deriveVariantAxes(undefined), []);
    assert.deepStrictEqual(deriveVariantAxes([]), []);
    // More than two axes is unsupported and falls back to no axes.
    assert.deepStrictEqual(
      deriveVariantAxes([
        { name: "A", values: ["1"] },
        { name: "B", values: ["1"] },
        { name: "C", values: ["1"] },
      ]),
      [],
    );
    // Duplicate axis names, duplicate values, and blank values are rejected.
    assert.deepStrictEqual(
      deriveVariantAxes([
        { name: "Curl", values: ["C"] },
        { name: "curl", values: ["D"] },
      ]),
      [],
    );
    assert.deepStrictEqual(
      deriveVariantAxes([{ name: "Curl", values: ["C", "c"] }]),
      [],
    );
    assert.deepStrictEqual(
      deriveVariantAxes([{ name: "Curl", values: ["C", "  "] }]),
      [],
    );
  });

  it("enumerates the cartesian product of the axes", () => {
    const axes = deriveVariantAxes([
      { name: "Curl", values: ["C", "CC"] },
      { name: "Length", values: ["8mm", "9mm"] },
    ]);
    const combinations = enumerateCombinations(axes);

    assert.strictEqual(combinations.length, 4);
    assert.deepStrictEqual(
      combinations.map((combination) => combination.label),
      ["C / 8mm", "C / 9mm", "CC / 8mm", "CC / 9mm"],
    );
    // Every combination has a stable, unique key.
    const keys = new Set(combinations.map((combination) => combination.key));
    assert.strictEqual(keys.size, 4);
  });

  it("handles a single-axis product", () => {
    const axes = deriveVariantAxes([{ name: "Size", values: ["S", "M", "L"] }]);
    const combinations = enumerateCombinations(axes);

    assert.deepStrictEqual(
      combinations.map((combination) => combination.label),
      ["S", "M", "L"],
    );
  });

  it("returns no combinations past the derivation cap", () => {
    // 11 x 10 = 110 combinations, above the 100 cap.
    const axes = deriveVariantAxes([
      { name: "A", values: Array.from({ length: 11 }, (_, i) => `a${i}`) },
      { name: "B", values: Array.from({ length: 10 }, (_, i) => `b${i}`) },
    ]);
    assert.ok(axes.length === 2);
    assert.strictEqual(enumerateCombinations(axes).length, 0);

    // Exactly at the cap still enumerates.
    const atCap = deriveVariantAxes([
      { name: "A", values: Array.from({ length: 10 }, (_, i) => `a${i}`) },
      { name: "B", values: Array.from({ length: 10 }, (_, i) => `b${i}`) },
    ]);
    assert.strictEqual(
      enumerateCombinations(atCap).length,
      MAX_VARIANT_COMBINATIONS,
    );
  });

  it("matches an override selection to its combination regardless of order", () => {
    const axes = deriveVariantAxes([
      { name: "Curl", values: ["C", "CC"] },
      { name: "Length", values: ["8mm", "9mm"] },
    ]);
    const combinations = enumerateCombinations(axes);
    const target = combinations.find(
      (combination) => combination.label === "C / 8mm",
    );
    assert.ok(target);

    // Authored in reverse order, with stega noise and different casing, still
    // fingerprints to the same combination.
    const fingerprint = overrideSelectionFingerprint([
      { name: "Length", value: "8MM" },
      { name: "curl", value: "c" },
    ]);
    assert.strictEqual(fingerprint, target.fingerprint);
  });

  it("returns a null fingerprint for malformed selections", () => {
    assert.strictEqual(overrideSelectionFingerprint(undefined), null);
    assert.strictEqual(overrideSelectionFingerprint([]), null);
    assert.strictEqual(
      overrideSelectionFingerprint([{ name: "Curl", value: "" }]),
      null,
    );
    // A repeated axis is malformed and never matches a real combination.
    assert.strictEqual(
      overrideSelectionFingerprint([
        { name: "Curl", value: "C" },
        { name: "Curl", value: "CC" },
      ]),
      null,
    );
  });

  it("builds a keyed select value for a combination", () => {
    const axes = deriveVariantAxes([
      { name: "Curl", values: ["C", "CC"] },
      { name: "Length", values: ["8mm", "9mm"] },
    ]);
    const [first] = enumerateCombinations(axes);
    const select = buildSelectValue(first);

    assert.deepStrictEqual(
      select.map(({ name, value }) => ({ name, value })),
      [
        { name: "Curl", value: "C" },
        { name: "Length", value: "8mm" },
      ],
    );
    // Keys are present, stable, and unique per axis.
    assert.ok(select.every((entry) => typeof entry._key === "string"));
    assert.strictEqual(new Set(select.map((entry) => entry._key)).size, 2);
    // The written selection round-trips to the same combination fingerprint.
    assert.strictEqual(overrideSelectionFingerprint(select), first.fingerprint);
  });

  it("keeps fingerprints stable across separately derived axes", () => {
    const build = () =>
      enumerateCombinations(
        deriveVariantAxes([
          { name: "Curl", values: ["C", "CC"] },
          { name: "Length", values: ["8mm", "9mm"] },
        ]),
      );
    const first = build();
    const second = build();
    assert.deepStrictEqual(
      first.map((c) => [c.key, c.fingerprint]),
      second.map((c) => [c.key, c.fingerprint]),
    );
  });

  it("selectionFingerprint is order-independent", () => {
    const a = selectionFingerprint([
      { name: "Curl", value: "C" },
      { name: "Length", value: "8mm" },
    ]);
    const b = selectionFingerprint([
      { name: "Length", value: "8mm" },
      { name: "Curl", value: "C" },
    ]);
    assert.strictEqual(a, b);
  });
});
