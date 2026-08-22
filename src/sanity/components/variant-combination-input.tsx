"use client";

import { useCallback, useMemo } from "react";
import { stegaClean } from "@sanity/client/stega";
import { Select, Stack, Text } from "@sanity/ui";
import {
  set,
  unset,
  useFormValue,
  type ArrayOfObjectsInputProps,
} from "sanity";

import {
  deriveVariantAxes,
  selectionKeyForAxis,
} from "@/sanity/lib/variant-combinations";

/**
 * Replaces the raw `{name, value}` sub-array editor on a variant override's
 * `select` field with one dropdown per option axis, populated from the same
 * `options` field that defines the product's variants. Editors pick a
 * combination from the values they already authored instead of re-typing option
 * names and values, so targeting an override stays attached to variant
 * creation. Falls back to the default array editor when no usable options
 * exist yet.
 */

const UNSET = "__unset__";

function cleanValue(value: unknown): string {
  return typeof value === "string"
    ? stegaClean(value).normalize("NFKC").trim()
    : "";
}

export function VariantCombinationInput(props: ArrayOfObjectsInputProps) {
  const { value, onChange, readOnly, renderDefault } = props;
  const options = useFormValue(["options"]);
  const axes = useMemo(() => deriveVariantAxes(options), [options]);

  // Current selection as normalizedAxisName -> chosen display value.
  const chosen = useMemo(() => {
    const map = new Map<string, string>();
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === "object") {
          const name = cleanValue(
            (entry as { name?: unknown }).name,
          ).toLowerCase();
          const chosenValue = cleanValue((entry as { value?: unknown }).value);
          if (name && chosenValue) map.set(name, chosenValue);
        }
      }
    }
    return map;
  }, [value]);

  const handleChange = useCallback(
    (axisNormalizedName: string, nextValue: string) => {
      const next = new Map(chosen);
      if (nextValue === UNSET || nextValue === "") {
        next.delete(axisNormalizedName);
      } else {
        next.set(axisNormalizedName, nextValue);
      }

      // Write one keyed row per chosen axis, in axis order, reusing stable keys.
      const nextSelect = axes
        .filter((axis) => next.has(axis.normalizedName))
        .map((axis) => ({
          _key: selectionKeyForAxis(axis.key),
          name: axis.name,
          value: next.get(axis.normalizedName) as string,
        }));

      onChange(nextSelect.length === 0 ? unset() : set(nextSelect));
    },
    [axes, chosen, onChange],
  );

  if (axes.length === 0) {
    return renderDefault(props);
  }

  return (
    <Stack space={4}>
      {axes.map((axis) => {
        const current = chosen.get(axis.normalizedName) ?? "";
        const currentIsKnown =
          current === "" ||
          axis.choices.some((choice) => choice.value === current);

        return (
          <Stack space={2} key={axis.key}>
            <Text size={1} weight="medium">
              {axis.name}
            </Text>
            <Select
              value={current === "" ? UNSET : current}
              readOnly={readOnly}
              onChange={(event) =>
                handleChange(axis.normalizedName, event.currentTarget.value)
              }
            >
              <option value={UNSET}>Choose {axis.name}…</option>
              {!currentIsKnown && current !== "" ? (
                <option value={current}>{current} (unavailable)</option>
              ) : null}
              {axis.choices.map((choice) => (
                <option key={choice.normalizedValue} value={choice.value}>
                  {choice.value}
                </option>
              ))}
            </Select>
          </Stack>
        );
      })}
    </Stack>
  );
}
