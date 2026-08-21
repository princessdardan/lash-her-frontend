import { createHash } from "node:crypto";
import { stegaClean } from "@sanity/client/stega";

import type {
  TProduct,
  TProductOption,
  TProductShippingMetadata,
  TProductVariant,
  TProductVariantOption,
  TProductVariantOverride,
  TSanityImage,
} from "@/types";

const MAX_DERIVED_VARIANTS = 100;
const DERIVED_KEY_PREFIX = "derived_v1_";
const CONFIGURATION_UNAVAILABLE_LABEL = "Option configuration unavailable";

interface AxisChoice {
  readonly value: string;
  readonly normalizedValue: string;
}

interface OptionAxis {
  readonly name: string;
  readonly normalizedName: string;
  readonly choices: AxisChoice[];
}

interface ResolvedOverride {
  readonly price?: number;
  readonly discountPrice?: number | null;
  readonly sku?: string;
  readonly isAvailable?: boolean;
  readonly availabilityLabel?: string;
  readonly stockQuantity?: number;
  readonly image?: TSanityImage;
  readonly shipping?: TProductShippingMetadata;
}

/**
 * Expands a product's authored option axes into the concrete purchasable
 * variants that cart, checkout, and shipping consume. Combinations inherit the
 * product-level price, stock, and shipping unless a sparse `variantOverrides`
 * entry targets that exact combination. Products with no options are returned
 * untouched (a single purchasable item).
 */
export function normalizeProductVariantModel(product: TProduct): TProduct {
  const cleaned = cleanProduct(product);
  const axes = parseAxes(cleaned.options);

  // No options -> single purchasable product, nothing to derive.
  if (axes !== null && axes.length === 0) {
    return cleaned.variants === undefined
      ? cleaned
      : { ...cleaned, variants: undefined };
  }

  if (axes === null) return quarantineProduct(cleaned);

  const combinationCount = axes.reduce(
    (count, axis) => count * axis.choices.length,
    1,
  );
  if (combinationCount > MAX_DERIVED_VARIANTS) {
    return quarantineProduct(cleaned);
  }

  const overrides = indexOverrides(cleaned.variantOverrides, axes);
  const variants = buildVariants(cleaned, axes, overrides);

  return { ...cleaned, variants };
}

function parseAxes(options: TProductOption[] | undefined): OptionAxis[] | null {
  if (!options || options.length === 0) return [];
  if (options.length > 2) return null;

  const axes: OptionAxis[] = [];
  const seenNames = new Set<string>();

  for (const option of options) {
    const name = cleanString(option.name);
    const normalizedName = normalizeIdentity(name);
    if (!name || !normalizedName || seenNames.has(normalizedName)) return null;
    seenNames.add(normalizedName);

    const choices: AxisChoice[] = [];
    const seenValues = new Set<string>();
    for (const rawValue of option.values ?? []) {
      const value = cleanString(rawValue);
      const normalizedValue = normalizeIdentity(value);
      if (!value || !normalizedValue || seenValues.has(normalizedValue)) {
        return null;
      }
      seenValues.add(normalizedValue);
      choices.push({ value, normalizedValue });
    }

    if (choices.length === 0) return null;
    axes.push({ name, normalizedName, choices });
  }

  return axes;
}

function indexOverrides(
  overrides: TProductVariantOverride[] | undefined,
  axes: OptionAxis[],
): Map<string, ResolvedOverride> {
  const byFingerprint = new Map<string, ResolvedOverride>();
  if (!overrides) return byFingerprint;

  const axisNames = new Set(axes.map((axis) => axis.normalizedName));

  for (const override of overrides) {
    const selection = new Map<string, string>();
    let malformed = false;

    for (const option of override.select ?? []) {
      const name = normalizeIdentity(cleanString(option.name));
      const value = normalizeIdentity(cleanString(option.value));
      if (!name || !value || !axisNames.has(name) || selection.has(name)) {
        malformed = true;
        break;
      }
      selection.set(name, value);
    }

    // An override must pin exactly one full combination to apply.
    if (malformed || selection.size !== axes.length) continue;

    const fingerprint = fingerprintSelection(selection);
    if (byFingerprint.has(fingerprint)) continue; // first authored wins
    byFingerprint.set(fingerprint, resolveOverride(override));
  }

  return byFingerprint;
}

function resolveOverride(override: TProductVariantOverride): ResolvedOverride {
  const price = toPositiveNumber(override.price);
  const shipping = hasShippingOverride(override.shipping)
    ? override.shipping
    : undefined;
  const sku = cleanString(override.sku) ?? undefined;
  const availabilityLabel =
    cleanString(override.availabilityLabel) ?? undefined;
  const stockQuantity = toStockQuantity(override.stockQuantity);
  const image = hasImageAsset(override.image) ? override.image : undefined;

  return {
    ...(price !== null ? { price } : {}),
    ...(override.discountPrice === undefined
      ? {}
      : { discountPrice: toPositiveNumber(override.discountPrice) }),
    ...(sku ? { sku } : {}),
    ...(typeof override.isAvailable === "boolean"
      ? { isAvailable: override.isAvailable }
      : {}),
    ...(availabilityLabel ? { availabilityLabel } : {}),
    ...(stockQuantity !== null ? { stockQuantity } : {}),
    ...(image ? { image } : {}),
    ...(shipping ? { shipping } : {}),
  };
}

function buildVariants(
  product: TProduct,
  axes: OptionAxis[],
  overrides: Map<string, ResolvedOverride>,
): TProductVariant[] {
  const publishedProductId = product._id.replace(/^drafts\./, "");
  const basePrice = toPositiveNumber(product.price) ?? 0;
  const productDiscount = toPositiveNumber(product.discountPrice);

  return cartesianSelections(axes).map((selection) => {
    const normalizedSelection = new Map(
      selection.map(({ axis, choice }) => [
        axis.normalizedName,
        choice.normalizedValue,
      ]),
    );
    const override =
      overrides.get(fingerprintSelection(normalizedSelection)) ?? {};

    const options: TProductVariantOption[] = selection.map(
      ({ axis, choice }) => ({
        _key: `option_${shortHash(axis.normalizedName)}`,
        name: axis.name,
        value: choice.value,
      }),
    );

    const price = override.price ?? basePrice;
    const usesOwnPrice = override.price !== undefined;
    const rawDiscount = usesOwnPrice
      ? (override.discountPrice ?? null)
      : (override.discountPrice ?? productDiscount ?? null);
    const discountPrice =
      typeof rawDiscount === "number" && rawDiscount < price
        ? rawDiscount
        : null;
    const isAvailable = product.isAvailable && (override.isAvailable ?? true);

    return {
      _key: derivedVariantKey(publishedProductId, normalizedSelection),
      title: selection.map(({ choice }) => choice.value).join(" / "),
      price,
      discountPrice,
      isAvailable,
      options,
      ...(override.sku ? { sku: override.sku } : {}),
      ...(override.availabilityLabel
        ? { availabilityLabel: override.availabilityLabel }
        : {}),
      ...(override.stockQuantity !== undefined
        ? { stockQuantity: override.stockQuantity }
        : {}),
      ...(override.image ? { image: override.image } : {}),
      ...(override.shipping ? { shipping: override.shipping } : {}),
    };
  });
}

function cartesianSelections(
  axes: OptionAxis[],
): Array<Array<{ axis: OptionAxis; choice: AxisChoice }>> {
  return axes.reduce<Array<Array<{ axis: OptionAxis; choice: AxisChoice }>>>(
    (selections, axis) =>
      selections.flatMap((selection) =>
        axis.choices.map((choice) => [...selection, { axis, choice }]),
      ),
    [[]],
  );
}

/**
 * Stable per-combination key. Kept byte-for-byte compatible with the previous
 * derived scheme so any `variantId` already stored in a cart or order still
 * resolves after the schema change.
 */
function derivedVariantKey(
  publishedProductId: string,
  normalizedSelection: ReadonlyMap<string, string>,
): string {
  const canonicalSelection = [...normalizedSelection.entries()]
    .map(([name, value]) => [name, value])
    .sort(([left], [right]) => compareCodePoints(left, right));
  const digest = createHash("sha256")
    .update(JSON.stringify([publishedProductId, 1, canonicalSelection]))
    .digest("hex")
    .slice(0, 32);

  return `${DERIVED_KEY_PREFIX}${digest}`;
}

function fingerprintSelection(selection: ReadonlyMap<string, string>): string {
  return JSON.stringify(
    [...selection.entries()].sort(([left], [right]) =>
      compareCodePoints(left, right),
    ),
  );
}

function quarantineProduct(product: TProduct): TProduct {
  return {
    ...product,
    isAvailable: false,
    availabilityLabel: CONFIGURATION_UNAVAILABLE_LABEL,
    variants: [],
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

function hasImageAsset(image: TSanityImage | undefined): image is TSanityImage {
  return typeof image?.asset?._ref === "string" && image.asset._ref.length > 0;
}

function toPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

// A blank/invalid stock value means "untracked" (null); an authored 0 is a
// real set-point (tracked, sold out) and is preserved.
function toStockQuantity(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

function cleanProduct(product: TProduct): TProduct {
  const options = cleanOptions(product.options);
  const variantOverrides = cleanOverrides(product.variantOverrides);

  if (
    options === product.options &&
    variantOverrides === product.variantOverrides
  ) {
    return product;
  }

  return {
    ...product,
    ...(options === undefined ? {} : { options }),
    ...(variantOverrides === undefined ? {} : { variantOverrides }),
  };
}

function cleanOptions(
  options: TProductOption[] | undefined,
): TProductOption[] | undefined {
  if (!options) return options;
  let changed = false;

  const cleaned = options.map((option) => {
    const name = cleanStegaValue(option.name);
    const values = option.values?.map((value) => cleanStegaValue(value));
    const valuesChanged = values?.some(
      (value, index) => value !== option.values?.[index],
    );
    if (name === option.name && !valuesChanged) return option;

    changed = true;
    return { ...option, name, ...(values === undefined ? {} : { values }) };
  });

  return changed ? cleaned : options;
}

function cleanOverrides(
  overrides: TProductVariantOverride[] | undefined,
): TProductVariantOverride[] | undefined {
  if (!overrides) return overrides;
  let changed = false;

  const cleaned = overrides.map((override) => {
    if (!override.select) return override;
    let selectChanged = false;
    const select = override.select.map((option) => {
      const name = cleanStegaValue(option.name);
      const value = cleanStegaValue(option.value);
      if (name === option.name && value === option.value) return option;
      selectChanged = true;
      return { ...option, name, value };
    });
    if (!selectChanged) return override;

    changed = true;
    return { ...override, select };
  });

  return changed ? cleaned : overrides;
}

function cleanStegaValue<T extends string | null | undefined>(value: T): T {
  return (typeof value === "string" ? stegaClean(value) : value) as T;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = stegaClean(value).normalize("NFKC").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeIdentity(value: unknown): string | null {
  return cleanString(value)?.toLowerCase() ?? null;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
