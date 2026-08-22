import { stegaClean } from "@sanity/client/stega";

import type { TProductVariantOption } from "@/types";

/**
 * Framework-free helpers shared by the Studio variant-authoring components and
 * their unit tests. This module must stay free of React, `@sanity/ui`, and
 * `node:crypto` so it bundles into the browser Studio and runs under `tsx`.
 *
 * The purchasable combinations are the cartesian product of the (at most two)
 * authored option axes. An editor never re-types a combination: the components
 * enumerate them from the same `options` field that defines the variants, then
 * match any existing `variantOverrides[].select` back to a combination by a
 * normalized, order-independent fingerprint. Normalization mirrors
 * `product-variant-model.ts` (stega clean + NFKC + trim + lowercase) so a
 * fingerprint computed here targets the exact combination the model derives.
 */

/** Keep in lockstep with the derivation cap in product-variant-model.ts. */
export const MAX_VARIANT_COMBINATIONS = 100;

export interface VariantAxisChoice {
  /** Cleaned, human-facing value (e.g. "8mm"). */
  readonly value: string;
  /** Lower-cased identity used for matching (e.g. "8mm"). */
  readonly normalizedValue: string;
}

export interface VariantAxis {
  /** Cleaned, human-facing axis name (e.g. "Length"). */
  readonly name: string;
  /** Lower-cased identity used for matching (e.g. "length"). */
  readonly normalizedName: string;
  /** Stable key for the axis, used when writing selection `_key`s. */
  readonly key: string;
  readonly choices: readonly VariantAxisChoice[];
}

export interface VariantCombinationSelection {
  readonly name: string;
  readonly value: string;
  /** Stable per-axis key so rewritten `select` arrays keep the same keys. */
  readonly key: string;
}

export interface VariantCombination {
  /** Deterministic, stable key derived from the combination fingerprint. */
  readonly key: string;
  /** Human-facing label, e.g. "C / 8mm". */
  readonly label: string;
  /** Normalized, order-independent identity used to match overrides. */
  readonly fingerprint: string;
  readonly selections: readonly VariantCombinationSelection[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = stegaClean(value).normalize("NFKC").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeIdentity(value: string): string {
  return value.toLowerCase();
}

/**
 * Small, dependency-free string hash (djb2 → base36). Used only to make stable
 * array `_key`s for generated selections/overrides; it is not security
 * sensitive and never leaves the Studio document.
 */
function hashKey(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  // `>>> 0` folds to an unsigned 32-bit int so the key is a short, stable slug.
  return (hash >>> 0).toString(36);
}

/**
 * Cleans the authored `options` into the axes used to enumerate combinations.
 * Returns an empty array for a product with no usable options, or when the
 * options are malformed/duplicated (the schema validation surfaces the real
 * error; the authoring UI simply falls back to its default rendering).
 */
export function deriveVariantAxes(options: unknown): VariantAxis[] {
  if (!Array.isArray(options) || options.length === 0) return [];
  if (options.length > 2) return [];

  const axes: VariantAxis[] = [];
  const seenNames = new Set<string>();

  for (const option of options) {
    if (!isRecord(option)) return [];
    const name = cleanString(option.name);
    if (!name) return [];
    const normalizedName = normalizeIdentity(name);
    if (seenNames.has(normalizedName)) return [];
    seenNames.add(normalizedName);

    const choices: VariantAxisChoice[] = [];
    const seenValues = new Set<string>();
    const rawValues = Array.isArray(option.values) ? option.values : [];
    for (const rawValue of rawValues) {
      const value = cleanString(rawValue);
      if (!value) return [];
      const normalizedValue = normalizeIdentity(value);
      if (seenValues.has(normalizedValue)) return [];
      seenValues.add(normalizedValue);
      choices.push({ value, normalizedValue });
    }

    if (choices.length === 0) return [];
    axes.push({
      name,
      normalizedName,
      key: `axis_${hashKey(normalizedName)}`,
      choices,
    });
  }

  return axes;
}

/**
 * Order-independent identity for a set of `{name, value}` selections. Two
 * selections that pin the same combination (in any order) share a fingerprint.
 */
export function selectionFingerprint(
  selections: ReadonlyArray<{ name: string; value: string }>,
): string {
  return JSON.stringify(
    selections
      .map(({ name, value }) => [
        normalizeIdentity(name),
        normalizeIdentity(value),
      ])
      .sort(([leftName], [rightName]) =>
        leftName < rightName ? -1 : leftName > rightName ? 1 : 0,
      ),
  );
}

/**
 * The fingerprint of an authored override's `select`, or `null` when the
 * selection is malformed (missing name/value or a repeated axis). A `null`
 * result never matches a real combination.
 */
export function overrideSelectionFingerprint(select: unknown): string | null {
  if (!Array.isArray(select)) return null;
  const selections: Array<{ name: string; value: string }> = [];
  const seenAxes = new Set<string>();

  for (const entry of select) {
    if (!isRecord(entry)) return null;
    const name = cleanString(entry.name);
    const value = cleanString(entry.value);
    if (!name || !value) return null;
    const normalizedName = normalizeIdentity(name);
    if (seenAxes.has(normalizedName)) return null;
    seenAxes.add(normalizedName);
    selections.push({ name, value });
  }

  if (selections.length === 0) return null;
  return selectionFingerprint(selections);
}

/**
 * Enumerates every purchasable combination as the cartesian product of the
 * axes. Returns an empty array when there are no axes or the product would
 * exceed {@link MAX_VARIANT_COMBINATIONS} (matching the derivation cap).
 */
export function enumerateCombinations(
  axes: readonly VariantAxis[],
): VariantCombination[] {
  if (axes.length === 0) return [];

  const total = axes.reduce((count, axis) => count * axis.choices.length, 1);
  if (total > MAX_VARIANT_COMBINATIONS) return [];

  let rows: VariantCombinationSelection[][] = [[]];
  for (const axis of axes) {
    rows = rows.flatMap((row) =>
      axis.choices.map((choice) => [
        ...row,
        { name: axis.name, value: choice.value, key: axis.key },
      ]),
    );
  }

  return rows.map((selections) => {
    const fingerprint = selectionFingerprint(selections);
    return {
      key: `ovr_${hashKey(fingerprint)}`,
      label: selections.map((selection) => selection.value).join(" / "),
      fingerprint,
      selections,
    };
  });
}

/**
 * Stable `_key` for a selection row on a given axis. Shared by the matrix
 * (which writes whole combinations) and the combination picker (which edits one
 * axis at a time) so the two never churn each other's keys.
 */
export function selectionKeyForAxis(axisKey: string): string {
  return `sel_${hashKey(axisKey)}`;
}

/**
 * Builds the `select` array value written to an override for a combination,
 * with stable per-axis `_key`s so re-selecting the same combination does not
 * churn keys.
 */
export function buildSelectValue(
  combination: VariantCombination,
): TProductVariantOption[] {
  return combination.selections.map((selection) => ({
    _key: selectionKeyForAxis(selection.key),
    name: selection.name,
    value: selection.value,
  }));
}
