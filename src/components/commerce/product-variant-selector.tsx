"use client";

import { useMemo, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import type { TProduct, TProductVariant } from "@/types";

export interface ProductVariantSelectorProps {
  readonly product: TProduct;
  readonly selectedVariantId?: string;
  readonly selectedOptions?: Readonly<Record<string, string>>;
  readonly onVariantSelect?: (variant: TProductVariant) => void;
  readonly onOptionsChange?: (options: Record<string, string>) => void;
  readonly readOnly?: boolean;
  readonly className?: string;
}

interface OptionGroupViewModel {
  readonly key: string;
  readonly name: string;
  readonly values: string[];
}

function toTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getVariantOptionValue(variant: TProductVariant, groupName: string): string | undefined {
  const value = variant.options?.find((option) => toTrimmedString(option.name) === groupName)?.value;
  return toTrimmedString(value) ?? undefined;
}

function unique(values: Array<string | null>): string[] {
  return Array.from(new Set(values.map(toTrimmedString).filter((value): value is string => value !== null)));
}

function getOptionGroups(product: TProduct, variants: TProductVariant[]): OptionGroupViewModel[] {
  const definedGroups = product.optionGroups?.flatMap((group, index) => {
    if (typeof group.name !== "string") return [];

    const groupName = group.name.trim();
    if (!groupName) return [];

    const variantValues = variants.flatMap((variant) =>
      variant.options?.filter((option) => toTrimmedString(option.name) === groupName).map((option) => option.value) ?? [],
    );

    return [
      {
        key: group._key || `${groupName}-${index}`,
        name: groupName,
        values: unique([...(group.values ?? []), ...variantValues]),
      },
    ];
  }) ?? [];

  const knownGroupNames = new Set(definedGroups.map((group) => group.name));
  const inferredGroups = variants.reduce<Record<string, string[]>>((groups, variant) => {
    variant.options?.forEach((option) => {
      if (typeof option.name !== "string" || typeof option.value !== "string") return;

      const optionName = option.name.trim();
      const optionValue = option.value.trim();
      if (!optionName || !optionValue || knownGroupNames.has(optionName)) return;

      groups[optionName] ??= [];
      groups[optionName].push(optionValue);
    });

    return groups;
  }, {});

  return [
    ...definedGroups,
    ...Object.entries(inferredGroups).map(([name, values]) => ({
      key: name,
      name,
      values: unique(values),
    })),
  ].filter((group) => group.values.length > 0);
}

function variantMatchesOptions(variant: TProductVariant, options: Readonly<Record<string, string>>): boolean {
  return Object.entries(options).every(([name, value]) => !value || getVariantOptionValue(variant, name) === value);
}

export function ProductVariantSelector({
  product,
  selectedVariantId,
  selectedOptions = {},
  onVariantSelect,
  onOptionsChange,
  readOnly = false,
  className,
}: ProductVariantSelectorProps): ReactElement | null {
  const variants = useMemo(() => product.variants ?? [], [product.variants]);
  const optionGroups = useMemo(() => getOptionGroups(product, variants), [product, variants]);
  const selectedVariant = selectedVariantId ? variants.find((variant) => variant._key === selectedVariantId) : undefined;

  if (variants.length === 0 && optionGroups.length === 0) {
    return null;
  }

  const handleVariantClick = (variant: TProductVariant) => {
    if (readOnly || !variant.isAvailable || !product.isAvailable) return;

    onVariantSelect?.(variant);
  };

  const handleOptionClick = (groupName: string, value: string, isAvailableForCheckout: boolean) => {
    if (readOnly || !isAvailableForCheckout) return;

    const nextOptions = { ...selectedOptions, [groupName]: value };
    const matchingVariant = variants.find((variant) => variant.isAvailable && variantMatchesOptions(variant, nextOptions));

    onOptionsChange?.(nextOptions);
    if (matchingVariant) onVariantSelect?.(matchingVariant);
  };

  if (optionGroups.length > 0) {
    return (
      <div className={cn("space-y-6", className)}>
        <div>
          <h2 className="section-subheading text-3xl" id="product-options-heading">
            Available Options
          </h2>
          {readOnly ? (
            <p className="mt-2 font-body text-sm font-bold leading-6 text-lh-muted">
              Options are shown for selection context.
            </p>
          ) : null}
        </div>

        <div className="space-y-5">
          {optionGroups.map((group) => {
            const groupHeadingId = `product-option-${group.key}`;

            return (
              <section key={group.key} aria-labelledby={groupHeadingId} className="rounded-[24px] border border-lh-line bg-lh-white p-4 md:p-5">
                <h3 id={groupHeadingId} className="mb-3 font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-primary">
                  {group.name}
                </h3>
                {readOnly ? (
                  <ul className="flex flex-wrap gap-2" aria-label={`${group.name} options`}>
                    {group.values.map((value) => {
                      const nextOptions = { ...selectedOptions, [group.name]: value };
                      const hasVariantForValue = variants.length === 0 || variants.some((variant) => variantMatchesOptions(variant, nextOptions));
                      const isAvailableForCheckout = product.isAvailable && (
                        variants.length === 0 || variants.some((variant) => variant.isAvailable && variantMatchesOptions(variant, nextOptions))
                      );
                      const isUnavailable = !hasVariantForValue || !isAvailableForCheckout;

                      return (
                        <li
                          key={`${group.key}-${value}`}
                          aria-label={`${value}${isUnavailable ? ", unavailable for checkout" : ""}`}
                          className={cn(
                            "rounded-full border px-4 py-2 font-body text-sm font-bold",
                            isUnavailable
                              ? "border-lh-line bg-lh-neutral text-lh-muted line-through opacity-70"
                              : "border-lh-line bg-lh-neutral-2/70 text-lh-shadow",
                          )}
                        >
                          {value}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className="flex flex-wrap gap-2" role="group" aria-label={`${group.name} options`}>
                    {group.values.map((value) => {
                      const nextOptions = { ...selectedOptions, [group.name]: value };
                      const selectedValue = selectedOptions[group.name] ?? (selectedVariant ? getVariantOptionValue(selectedVariant, group.name) : undefined);
                      const isSelected = selectedValue === value;
                      const hasVariantForValue = variants.length === 0 || variants.some((variant) => variantMatchesOptions(variant, nextOptions));
                      const isAvailableForCheckout = product.isAvailable && (
                        variants.length === 0 || variants.some((variant) => variant.isAvailable && variantMatchesOptions(variant, nextOptions))
                      );
                      const isUnavailable = !hasVariantForValue || !isAvailableForCheckout;

                      return (
                        <button
                          key={`${group.key}-${value}`}
                          type="button"
                          disabled={isUnavailable}
                          aria-disabled={isUnavailable}
                          aria-pressed={isSelected}
                          aria-label={`${group.name}: ${value}${isUnavailable ? ", unavailable for checkout" : ""}`}
                          onClick={() => handleOptionClick(group.name, value, isAvailableForCheckout)}
                          className={cn(
                            "rounded-full border px-4 py-2 font-body text-sm font-bold transition-colors focus-visible:outline-lh-primary",
                            isSelected
                              ? "border-lh-primary bg-lh-primary text-lh-white"
                              : "border-lh-line bg-lh-neutral-2/70 text-lh-shadow",
                            !isSelected && !isUnavailable && "hover:border-lh-primary hover:bg-lh-primary-soft hover:text-lh-primary",
                            isUnavailable && !isSelected && "border-lh-line bg-lh-neutral text-lh-muted line-through opacity-70",
                            isUnavailable && "cursor-not-allowed",
                          )}
                        >
                          {value}
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-6", className)}>
      <div className="space-y-3">
        <h2 className="section-subheading text-3xl">
          Choose option
        </h2>
        {readOnly ? (
          <ul className="flex flex-wrap gap-2" aria-label="Product variants">
            {variants.map((variant) => {
              const isUnavailable = !product.isAvailable || !variant.isAvailable;

              return (
                <li
                  key={variant._key}
                  className={cn(
                    "rounded-full border px-4 py-2 font-body text-sm font-bold",
                    isUnavailable
                      ? "border-lh-line bg-lh-neutral text-lh-muted opacity-70"
                      : "border-lh-line bg-lh-neutral-2/70 text-lh-shadow",
                  )}
                >
                  <span>{variant.title}</span>
                  {variant.availabilityLabel && (
                    <span className="ml-2 text-xs uppercase tracking-[0.12em] opacity-80">
                      {variant.availabilityLabel}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Product variants">
            {variants.map((variant) => {
              const isSelected = selectedVariantId === variant._key;
              const isUnavailable = !product.isAvailable || !variant.isAvailable;

              return (
                <button
                  key={variant._key}
                  type="button"
                  disabled={isUnavailable}
                  aria-disabled={isUnavailable}
                  onClick={() => handleVariantClick(variant)}
                  aria-pressed={isSelected}
                  className={cn(
                    "rounded-full border px-4 py-2 font-body text-sm font-bold transition-colors focus-visible:outline-lh-primary",
                    isSelected
                      ? "border-lh-primary bg-lh-primary text-lh-white"
                      : "border-lh-line bg-lh-neutral-2/70 text-lh-shadow",
                    !isSelected && !isUnavailable && "hover:border-lh-primary hover:bg-lh-primary-soft hover:text-lh-primary",
                    isUnavailable && !isSelected && "bg-lh-neutral text-lh-muted opacity-70",
                    isUnavailable && !isSelected && "cursor-not-allowed",
                  )}
                >
                  <span>{variant.title}</span>
                  {variant.availabilityLabel && (
                    <span className="ml-2 text-xs uppercase tracking-[0.12em] opacity-80">
                      {variant.availabilityLabel}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
