"use client";

import { useCallback, useMemo, useState } from "react";
import { Badge, Button, Card, Flex, Grid, Stack, Text } from "@sanity/ui";
import { useFormValue, type ArrayOfObjectsInputProps } from "sanity";

import {
  buildSelectValue,
  deriveVariantAxes,
  enumerateCombinations,
  overrideSelectionFingerprint,
  type VariantCombination,
} from "@/sanity/lib/variant-combinations";

/**
 * Consolidated authoring surface for variant overrides. Instead of a detached
 * array where editors re-pin a combination by hand, this renders the product's
 * generated combinations as a compact, collapsible grid on top of the native
 * override list. Customizing a combination creates its override with the
 * combination already pinned and expands it inline; every combination left
 * alone inherits the product defaults. Falls back to the default array editor
 * whenever the options are absent or malformed.
 */

export function VariantOverridesInput(props: ArrayOfObjectsInputProps) {
  const { members, onItemAppend, onItemExpand, onItemRemove, renderDefault } =
    props;
  const options = useFormValue(["options"]);
  const [open, setOpen] = useState(true);

  const combinations = useMemo(
    () => enumerateCombinations(deriveVariantAxes(options)),
    [options],
  );

  // Match existing overrides back to a combination by their pinned selection.
  const customizedByFingerprint = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of members) {
      if (member.kind !== "item") continue;
      const select = (member.item.value as { select?: unknown } | undefined)
        ?.select;
      const fingerprint = overrideSelectionFingerprint(select);
      if (fingerprint && !map.has(fingerprint)) {
        map.set(fingerprint, member.key);
      }
    }
    return map;
  }, [members]);

  const handleCustomize = useCallback(
    (combination: VariantCombination) => {
      const existingKey = customizedByFingerprint.get(combination.fingerprint);
      if (existingKey) {
        onItemExpand(existingKey);
        return;
      }
      // The appended override pins the combination up front; `onItemAppend` is
      // typed to the minimal `{ _key }` item, so the extra fields ride along as
      // a structurally-wider value.
      const overrideItem = {
        _key: combination.key,
        select: buildSelectValue(combination),
      };
      onItemAppend(overrideItem);
      onItemExpand(combination.key);
    },
    [customizedByFingerprint, onItemAppend, onItemExpand],
  );

  // No usable options -> nothing to consolidate; render the native editor.
  if (combinations.length === 0) {
    return renderDefault(props);
  }

  const customizedCount = combinations.reduce(
    (count, combination) =>
      customizedByFingerprint.has(combination.fingerprint) ? count + 1 : count,
    0,
  );

  return (
    <Stack space={4}>
      <Card border radius={2} padding={3} tone="transparent">
        <Stack space={3}>
          <Flex align="flex-start" justify="space-between" gap={3}>
            <Stack space={2} flex={1}>
              <Text size={1} weight="semibold">
                Combinations
              </Text>
              <Text size={1} muted>
                {customizedCount === 0
                  ? "Every combination inherits the product defaults. Customize one only if it needs its own price, availability, stock, image, or shipping."
                  : `${customizedCount} of ${combinations.length} combination${
                      combinations.length === 1 ? "" : "s"
                    } customized. The rest inherit the product defaults.`}
              </Text>
            </Stack>
            <Button
              mode="bleed"
              fontSize={1}
              padding={2}
              text={open ? "Hide" : "Show"}
              onClick={() => setOpen((value) => !value)}
            />
          </Flex>

          {open ? (
            <Grid columns={[1, 2, 3]} gap={2}>
              {combinations.map((combination) => {
                const existingKey = customizedByFingerprint.get(
                  combination.fingerprint,
                );
                const isCustomized = Boolean(existingKey);

                return (
                  <Card
                    key={combination.key}
                    border
                    radius={2}
                    padding={3}
                    tone={isCustomized ? "primary" : "default"}
                  >
                    <Stack space={3}>
                      <Flex align="center" justify="space-between" gap={2}>
                        <Text size={1} weight="medium">
                          {combination.label}
                        </Text>
                        <Badge
                          tone={isCustomized ? "primary" : "default"}
                          mode="outline"
                          fontSize={0}
                        >
                          {isCustomized ? "Customized" : "Default"}
                        </Badge>
                      </Flex>

                      {isCustomized && existingKey ? (
                        <Flex gap={2}>
                          <Button
                            fontSize={1}
                            padding={2}
                            mode="ghost"
                            text="Edit"
                            onClick={() => onItemExpand(existingKey)}
                          />
                          <Button
                            fontSize={1}
                            padding={2}
                            mode="bleed"
                            tone="critical"
                            text="Reset"
                            onClick={() => onItemRemove(existingKey)}
                          />
                        </Flex>
                      ) : (
                        <Button
                          fontSize={1}
                          padding={2}
                          mode="ghost"
                          text="Customize"
                          onClick={() => handleCustomize(combination)}
                        />
                      )}
                    </Stack>
                  </Card>
                );
              })}
            </Grid>
          ) : null}
        </Stack>
      </Card>

      {renderDefault(props)}
    </Stack>
  );
}
