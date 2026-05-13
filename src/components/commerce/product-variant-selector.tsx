"use client";

import { useMemo, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import type { TSellableProduct, TSellableProductVariant } from "@/types";

export interface ProductVariantSelectorProps {
  product: TSellableProduct;
  selectedVariantId?: string;
  selectedOptions?: Record<string, string>;
  onVariantSelect?: (variant: TSellableProductVariant) => void;
  onOptionsChange?: (options: Record<string, string>) => void;
  readOnly?: boolean;
  className?: string;
}

export function ProductVariantSelector({
  product,
  selectedVariantId,
  selectedOptions,
  onVariantSelect,
  onOptionsChange,
  readOnly = false,
  className,
}: ProductVariantSelectorProps): ReactElement | null {
  const optionGroups = product.optionGroups ?? [];
  const variants = useMemo(() => product.variants ?? [], [product.variants]);

  const currentOptions = useMemo(() => {
    if (selectedOptions) {
      return selectedOptions;
    }
    if (selectedVariantId) {
      const variant = variants.find((v) => v._key === selectedVariantId);
      if (variant?.options) {
        const opts: Record<string, string> = {};
        for (const opt of variant.options) {
          opts[opt.name] = opt.value;
        }
        return opts;
      }
    }
    return {};
  }, [selectedOptions, selectedVariantId, variants]);

  if (optionGroups.length === 0) {
    return null;
  }

  const handleOptionClick = (groupName: string, value: string) => {
    if (readOnly) return;

    const newOptions = { ...currentOptions, [groupName]: value };
    
    if (onOptionsChange) {
      onOptionsChange(newOptions);
    }

    if (onVariantSelect) {
      const matchingVariant = variants.find((v) => {
        if (!v.options) return false;
        return v.options.every((opt) => newOptions[opt.name] === opt.value);
      });
      
      if (matchingVariant) {
        onVariantSelect(matchingVariant);
      }
    }
  };

  const isOptionAvailable = (groupName: string, value: string) => {
    if (optionGroups.length === 1) {
      return variants.some(
        (v) => v.isAvailable && v.options?.some((opt) => opt.name === groupName && opt.value === value)
      );
    }

    return variants.some((v) => {
      if (!v.isAvailable || !v.options) return false;
      
      const hasOption = v.options.some((opt) => opt.name === groupName && opt.value === value);
      if (!hasOption) return false;

      return v.options.every((opt) => {
        if (opt.name === groupName) return true;
        const selectedValue = currentOptions[opt.name];
        if (!selectedValue) return true;
        return opt.value === selectedValue;
      });
    });
  };

  return (
    <div className={cn("space-y-6", className)}>
      {optionGroups.map((group) => (
        <div key={group._key || group.name} className="space-y-3">
          <h4 className="text-xs font-bold uppercase tracking-wider text-lh-primary">
            {group.name}
          </h4>
          <div className="flex flex-wrap gap-2">
            {group.values?.map((value) => {
              const isSelected = currentOptions[group.name] === value;
              const isAvailable = isOptionAvailable(group.name, value);
              const disabled = readOnly || !isAvailable;

              return (
                <button
                  key={value}
                  type="button"
                  disabled={disabled}
                  onClick={() => handleOptionClick(group.name, value)}
                  aria-pressed={isSelected}
                  className={cn(
                    "px-4 py-2 text-sm font-bold font-sans rounded-md border transition-colors focus:outline-none focus:ring-2 focus:ring-lh-primary focus:ring-offset-2",
                    isSelected
                      ? "border-lh-primary bg-lh-primary text-white"
                      : "border-lh-line bg-white text-lh-shadow",
                    !readOnly && !isSelected && "hover:border-lh-primary/50",
                    !isAvailable && !isSelected && "opacity-50 text-lh-muted bg-lh-neutral-2",
                    !readOnly && !isAvailable && !isSelected && "cursor-not-allowed",
                    readOnly && "cursor-default"
                  )}
                >
                  {value}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
