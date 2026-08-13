import { createHash } from "node:crypto";
import { stegaClean } from "@sanity/client/stega";

import type {
  TProduct,
  TProductOptionGroup,
  TProductShippingMetadata,
  TProductVariant,
  TProductVariantOption,
} from "@/types";

const MAX_DERIVED_VARIANTS = 100;
const DERIVED_KEY_PREFIX = "derived_v1_";
const CONFIGURATION_UNAVAILABLE_LABEL = "Option configuration unavailable";

interface GroupedChoice {
  readonly key: string;
  readonly value: string;
  readonly normalizedValue: string;
}

interface GroupedVariant {
  readonly key: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly choices: GroupedChoice[];
  readonly source: TProductVariant;
}

interface CommerceMetadata {
  readonly price: number;
  readonly discountPrice: number | null;
  readonly isAvailable: boolean;
  readonly availabilityLabel?: string;
  readonly shipping?: TProductShippingMetadata;
}

type VariantClassification =
  | { readonly kind: "canonical" }
  | { readonly kind: "grouped"; readonly groups: GroupedVariant[] }
  | { readonly kind: "invalid" };

/**
 * Converts the legacy grouped authoring shape used by existing product drafts
 * into the concrete variant tuples required by cart, checkout, and shipping.
 * Canonical products are returned by reference without modification.
 */
export function normalizeProductVariantModel(product: TProduct): TProduct {
  const cleanedProduct = cleanOptionPaths(product);
  const classification = classifyVariants(cleanedProduct);
  if (classification.kind === "canonical") return cleanedProduct;
  if (classification.kind === "invalid") {
    return quarantineProduct(cleanedProduct, cleanedProduct.optionGroups ?? []);
  }

  const groups = classification.groups;

  const orderedGroups = orderGroups(groups, cleanedProduct.optionGroups);
  const optionGroups = orderedGroups.map(toOptionGroup);
  const combinationCount = orderedGroups.reduce(
    (count, group) => count * group.choices.length,
    1,
  );

  if (combinationCount > MAX_DERIVED_VARIANTS) {
    return quarantineProduct(cleanedProduct, optionGroups);
  }

  const commerce = resolveCommonCommerceMetadata(cleanedProduct, orderedGroups);
  const variants = buildDerivedVariants(
    cleanedProduct,
    orderedGroups,
    commerce,
  );

  if (!commerce || variants.length !== combinationCount) {
    return {
      ...cleanedProduct,
      isAvailable: false,
      availabilityLabel: CONFIGURATION_UNAVAILABLE_LABEL,
      optionGroups,
      variants: variants.map((variant) => ({
        ...variant,
        isAvailable: false,
        availabilityLabel: CONFIGURATION_UNAVAILABLE_LABEL,
      })),
    };
  }

  return {
    ...cleanedProduct,
    optionGroups,
    variants,
  };
}

function classifyVariants(product: TProduct): VariantClassification {
  const variants = product.variants ?? [];
  const declaredGroups = validateDeclaredGroups(product.optionGroups);
  if (!declaredGroups) return { kind: "invalid" };

  if (product.variantModel === "concrete") {
    return isCanonical(variants, declaredGroups.names)
      ? { kind: "canonical" }
      : { kind: "invalid" };
  }

  const grouped = parseGroupedVariants(variants);
  if (product.variantModel === "grouped") {
    return grouped &&
      (declaredGroups.names.size === 0 ||
        declaredGroupsMatch(grouped, declaredGroups.names))
      ? { kind: "grouped", groups: grouped }
      : { kind: "invalid" };
  }

  if (isCanonical(variants, declaredGroups.names)) {
    return { kind: "canonical" };
  }

  if (!grouped) return { kind: "invalid" };

  const declaredTitlesMatch =
    declaredGroups.names.size > 0 &&
    declaredGroupsMatch(grouped, declaredGroups.names);
  if (declaredTitlesMatch) return { kind: "grouped", groups: grouped };

  if (variants.length < 2) return { kind: "invalid" };

  const hasOnlyMultiChoiceGroups = grouped.every(
    (group) => group.choices.length >= 2,
  );

  return hasOnlyMultiChoiceGroups && haveDisjointChoiceNames(grouped)
    ? { kind: "grouped", groups: grouped }
    : { kind: "invalid" };
}

function validateDeclaredGroups(
  optionGroups: TProductOptionGroup[] | undefined,
): { readonly names: ReadonlySet<string> } | null {
  const names = new Set<string>();

  for (const group of optionGroups ?? []) {
    const name = normalizeIdentity(group.name);
    if (!name || names.has(name)) return null;
    names.add(name);

    const values = new Set<string>();
    for (const value of group.values ?? []) {
      const normalizedValue = normalizeIdentity(value);
      if (!normalizedValue || values.has(normalizedValue)) return null;
      values.add(normalizedValue);
    }
  }

  return { names };
}

function parseGroupedVariants(
  variants: TProductVariant[],
): GroupedVariant[] | null {
  if (variants.length === 0) return null;

  const groups: GroupedVariant[] = [];
  const seenGroupNames = new Set<string>();

  for (const [variantIndex, variant] of variants.entries()) {
    const name = cleanString(variant.title);
    const normalizedName = normalizeIdentity(name);
    const options = variant.options ?? [];

    if (
      !name ||
      !normalizedName ||
      seenGroupNames.has(normalizedName) ||
      options.length === 0
    ) {
      return null;
    }
    seenGroupNames.add(normalizedName);

    const choices: GroupedChoice[] = [];
    const seenValues = new Set<string>();
    let valueMode: "missing" | "self" | null = null;

    for (const [optionIndex, option] of options.entries()) {
      const authoredName = cleanString(option.name);
      const authoredValue = cleanString(option.value);
      const normalizedAuthoredName = normalizeIdentity(authoredName);
      const normalizedAuthoredValue = normalizeIdentity(authoredValue);
      const optionMode = authoredValue === null ? "missing" : "self";
      const value = authoredValue ?? authoredName;
      const normalizedValue = normalizeIdentity(value);

      if (
        !authoredName ||
        !normalizedAuthoredName ||
        !value ||
        !normalizedValue ||
        (optionMode === "self" &&
          normalizedAuthoredName !== normalizedAuthoredValue) ||
        (valueMode !== null && valueMode !== optionMode) ||
        seenValues.has(normalizedValue)
      ) {
        return null;
      }

      valueMode = optionMode;
      seenValues.add(normalizedValue);
      choices.push({
        key:
          cleanString(option._key) ??
          `choice_${optionIndex}_${shortHash(normalizedValue)}`,
        value,
        normalizedValue,
      });
    }

    groups.push({
      key:
        cleanString(variant._key) ??
        `group_${variantIndex}_${shortHash(normalizedName)}`,
      name,
      normalizedName,
      choices,
      source: variant,
    });
  }

  return groups;
}

function haveDisjointChoiceNames(groups: GroupedVariant[]): boolean {
  const seen = new Set<string>();

  for (const group of groups) {
    for (const choice of group.choices) {
      if (seen.has(choice.normalizedValue)) return false;
      seen.add(choice.normalizedValue);
    }
  }

  return true;
}

function declaredGroupsMatch(
  groups: GroupedVariant[],
  declaredNames: ReadonlySet<string>,
): boolean {
  return (
    groups.length === declaredNames.size &&
    groups.every((group) => declaredNames.has(group.normalizedName))
  );
}

function isCanonical(
  variants: TProductVariant[],
  declaredGroupNames: ReadonlySet<string>,
): boolean {
  if (variants.length === 0) return declaredGroupNames.size === 0;

  const optionCounts = variants.map((variant) => variant.options?.length ?? 0);
  if (optionCounts.every((count) => count === 0)) {
    return declaredGroupNames.size === 0;
  }
  if (optionCounts.some((count) => count === 0)) return false;

  let expectedNames: Set<string> | null = null;
  const seenTuples = new Set<string>();

  for (const variant of variants) {
    const valuesByName = new Map<string, string>();

    for (const option of variant.options ?? []) {
      const name = normalizeIdentity(option.name);
      const value = normalizeIdentity(option.value);
      if (!name || !value || valuesByName.has(name)) return false;
      valuesByName.set(name, value);
    }

    const names = new Set(valuesByName.keys());
    if (!expectedNames) {
      expectedNames = names;
    } else if (!setsEqual(expectedNames, names)) {
      return false;
    }

    const tuple = [...valuesByName.entries()]
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([name, value]) => [name, value]);
    const fingerprint = JSON.stringify(tuple);
    if (seenTuples.has(fingerprint)) return false;
    seenTuples.add(fingerprint);
  }

  return (
    expectedNames !== null &&
    (declaredGroupNames.size === 0 ||
      setsEqual(expectedNames, declaredGroupNames))
  );
}

function setsEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function orderGroups(
  groups: GroupedVariant[],
  authoredGroups: TProductOptionGroup[] | undefined,
): GroupedVariant[] {
  const authoredOrder = new Map<string, number>();
  for (const [index, group] of (authoredGroups ?? []).entries()) {
    const name = normalizeIdentity(group.name);
    if (name && !authoredOrder.has(name)) authoredOrder.set(name, index);
  }

  return groups
    .map((group, sourceIndex) => ({ group, sourceIndex }))
    .sort((left, right) => {
      const leftOrder = authoredOrder.get(left.group.normalizedName);
      const rightOrder = authoredOrder.get(right.group.normalizedName);
      if (leftOrder !== undefined && rightOrder !== undefined)
        return leftOrder - rightOrder;
      if (leftOrder !== undefined) return -1;
      if (rightOrder !== undefined) return 1;
      return left.sourceIndex - right.sourceIndex;
    })
    .map(({ group }) => group);
}

function toOptionGroup(group: GroupedVariant): TProductOptionGroup {
  return {
    _key: group.key,
    name: group.name,
    values: group.choices.map((choice) => choice.value),
  };
}

function resolveCommonCommerceMetadata(
  product: TProduct,
  groups: GroupedVariant[],
): CommerceMetadata | null {
  if (groups.some((group) => cleanString(group.source.sku) !== null))
    return null;

  const prices = groups.map((group) => toCents(group.source.price));
  if (prices.some((price) => price === null)) return null;
  const priceCents = prices[0];
  if (priceCents === null || prices.some((price) => price !== priceCents))
    return null;

  const discounts = groups.map((group) =>
    toOptionalCents(group.source.discountPrice ?? product.discountPrice),
  );
  const discountCents = discounts[0];
  if (
    discounts.some(
      (discount) => discount === INVALID_CENTS || discount !== discountCents,
    ) ||
    (typeof discountCents === "number" && discountCents >= priceCents)
  ) {
    return null;
  }

  const effectiveShipping = groups.map((group) =>
    hasShippingOverride(group.source.shipping)
      ? group.source.shipping
      : product.shipping,
  );
  const shippingFingerprint = stableSerialize(effectiveShipping[0]);
  if (
    effectiveShipping.some(
      (shipping) => stableSerialize(shipping) !== shippingFingerprint,
    )
  ) {
    return null;
  }

  const isAvailable = groups.every(
    (group) => group.source.isAvailable === true,
  );
  const labels = groups
    .map((group) => cleanString(group.source.availabilityLabel))
    .filter((label): label is string => label !== null);
  const availabilityLabel =
    labels.length === groups.length && new Set(labels).size === 1
      ? labels[0]
      : isAvailable
        ? undefined
        : "Unavailable";
  const commonShipping = effectiveShipping[0];
  const usesProductShipping =
    stableSerialize(commonShipping) === stableSerialize(product.shipping);

  return {
    price: priceCents / 100,
    discountPrice:
      typeof discountCents === "number" ? discountCents / 100 : null,
    isAvailable,
    ...(availabilityLabel ? { availabilityLabel } : {}),
    ...(!usesProductShipping && commonShipping
      ? { shipping: commonShipping }
      : {}),
  };
}

function hasShippingOverride(
  shipping: TProductShippingMetadata | undefined,
): shipping is TProductShippingMetadata {
  return Boolean(
    shipping &&
    Object.entries(shipping).some(
      ([key, value]) =>
        !key.startsWith("_") &&
        value !== undefined &&
        value !== null &&
        value !== "",
    ),
  );
}

const INVALID_CENTS = Symbol("invalid-cents");

function toOptionalCents(
  value: number | null | undefined,
): number | null | typeof INVALID_CENTS {
  if (value === undefined || value === null) return null;
  return toCents(value) ?? INVALID_CENTS;
}

function toCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  const cents = Math.round(value * 100);
  return Math.abs(value - cents / 100) < 1e-9 ? cents : null;
}

function buildDerivedVariants(
  product: TProduct,
  groups: GroupedVariant[],
  commerce: CommerceMetadata | null,
): TProductVariant[] {
  const selections = cartesianSelections(groups);
  const seenKeys = new Set<string>();
  const fallbackPrice =
    typeof product.price === "number" && Number.isFinite(product.price)
      ? product.price
      : 0;

  return selections.flatMap((selection) => {
    const key = derivedVariantKey(product._id, selection);
    if (seenKeys.has(key)) return [];
    seenKeys.add(key);

    const options: TProductVariantOption[] = selection.map(
      ({ group, choice }) => ({
        _key: `option_${shortHash(group.normalizedName)}`,
        name: group.name,
        value: choice.value,
      }),
    );

    return [
      {
        _key: key,
        title: selection.map(({ choice }) => choice.value).join(" / "),
        price: commerce?.price ?? fallbackPrice,
        discountPrice: commerce?.discountPrice ?? null,
        isAvailable: commerce?.isAvailable ?? false,
        ...(commerce?.availabilityLabel
          ? { availabilityLabel: commerce.availabilityLabel }
          : {}),
        options,
        ...(commerce?.shipping ? { shipping: commerce.shipping } : {}),
      },
    ];
  });
}

function cartesianSelections(
  groups: GroupedVariant[],
): Array<Array<{ group: GroupedVariant; choice: GroupedChoice }>> {
  return groups.reduce<
    Array<Array<{ group: GroupedVariant; choice: GroupedChoice }>>
  >(
    (selections, group) =>
      selections.flatMap((selection) =>
        group.choices.map((choice) => [...selection, { group, choice }]),
      ),
    [[]],
  );
}

function derivedVariantKey(
  productId: string,
  selection: Array<{ group: GroupedVariant; choice: GroupedChoice }>,
): string {
  const canonicalSelection = selection
    .map(({ group, choice }) => [group.normalizedName, choice.normalizedValue])
    .sort(([leftGroup], [rightGroup]) =>
      compareCodePoints(leftGroup, rightGroup),
    );
  const publishedProductId = productId.replace(/^drafts\./, "");
  const digest = createHash("sha256")
    .update(JSON.stringify([publishedProductId, 1, canonicalSelection]))
    .digest("hex")
    .slice(0, 32);

  return `${DERIVED_KEY_PREFIX}${digest}`;
}

function quarantineProduct(
  product: TProduct,
  optionGroups: TProductOptionGroup[],
): TProduct {
  return {
    ...product,
    isAvailable: false,
    availabilityLabel: CONFIGURATION_UNAVAILABLE_LABEL,
    optionGroups,
    variants: product.variants?.map((variant) => ({
      ...variant,
      isAvailable: false,
      availabilityLabel: CONFIGURATION_UNAVAILABLE_LABEL,
    })),
  };
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = stegaClean(value).normalize("NFKC").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function cleanOptionPaths(product: TProduct): TProduct {
  const variantModel = cleanStegaValue(product.variantModel);
  const optionGroups = cleanOptionGroups(product.optionGroups);
  const variants = cleanVariantOptions(product.variants);

  if (
    variantModel === product.variantModel &&
    optionGroups === product.optionGroups &&
    variants === product.variants
  ) {
    return product;
  }

  return {
    ...product,
    ...(variantModel === undefined ? {} : { variantModel }),
    ...(optionGroups === undefined ? {} : { optionGroups }),
    ...(variants === undefined ? {} : { variants }),
  };
}

function cleanOptionGroups(
  groups: TProductOptionGroup[] | undefined,
): TProductOptionGroup[] | undefined {
  if (!groups) return groups;
  let changed = false;

  const cleanedGroups = groups.map((group) => {
    const name = cleanStegaValue(group.name);
    const values = group.values?.map((value) => cleanStegaValue(value));
    const valuesChanged = values?.some(
      (value, index) => value !== group.values?.[index],
    );
    if (name === group.name && !valuesChanged) return group;

    changed = true;
    return {
      ...group,
      name,
      ...(values === undefined ? {} : { values }),
    };
  });

  return changed ? cleanedGroups : groups;
}

function cleanVariantOptions(
  variants: TProductVariant[] | undefined,
): TProductVariant[] | undefined {
  if (!variants) return variants;
  let variantsChanged = false;

  const cleanedVariants = variants.map((variant) => {
    if (!variant.options) return variant;
    let optionsChanged = false;
    const options = variant.options.map((option) => {
      const name = cleanStegaValue(option.name);
      const value = cleanStegaValue(option.value);
      if (name === option.name && value === option.value) return option;

      optionsChanged = true;
      return { ...option, name, value };
    });
    if (!optionsChanged) return variant;

    variantsChanged = true;
    return { ...variant, options };
  });

  return variantsChanged ? cleanedVariants : variants;
}

function cleanStegaValue<T extends string | null | undefined>(value: T): T {
  return (typeof value === "string" ? stegaClean(value) : value) as T;
}

function normalizeIdentity(value: unknown): string | null {
  return cleanString(value)?.toLowerCase() ?? null;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value)) ?? "undefined";
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, entryValue]) => [key, sortObjectKeys(entryValue)]),
  );
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
