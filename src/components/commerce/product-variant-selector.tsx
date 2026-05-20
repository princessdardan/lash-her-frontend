"use client";

import { useMemo, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import type { TProduct, TProductVariant } from "@/types";

export interface ProductVariantSelectorProps {
  product: TProduct;
  selectedVariantId?: string;
  selectedOptions?: Record<string, string>;
  onVariantSelect?: (variant: TProductVariant) => void;
  onOptionsChange?: (options: Record<string, string>) => void;
  readOnly?: boolean;
  className?: string;
}

export function ProductVariantSelector({
  product,
  selectedVariantId,
  onVariantSelect,
  readOnly = false,
  className,
}: ProductVariantSelectorProps): ReactElement | null {
  const variants = useMemo(() => product.variants ?? [], [product.variants]);

  if (variants.length === 0) {
    return null;
  }

  const handleVariantClick = (variant: TProductVariant) => {
    if (readOnly) return;

    onVariantSelect?.(variant);
  };

  return (
    <div className={cn("space-y-6", className)}>
      <div className="space-y-3">
        <h4 className="text-xs font-bold uppercase tracking-wider text-lh-primary">
          Choose option
        </h4>
        <div className="flex flex-wrap gap-2">
          {variants.map((variant) => {
            const isSelected = selectedVariantId === variant._key;
            const disabled = readOnly || !variant.isAvailable;

            return (
              <button
                key={variant._key}
                type="button"
                disabled={disabled}
                onClick={() => handleVariantClick(variant)}
                aria-pressed={isSelected}
                className={cn(
                  "px-4 py-2 text-sm font-bold font-sans rounded-md border transition-colors focus:outline-none focus:ring-2 focus:ring-lh-primary focus:ring-offset-2",
                  isSelected
                    ? "border-lh-primary bg-lh-primary text-white"
                    : "border-lh-line bg-white text-lh-shadow",
                  !readOnly && !isSelected && "hover:border-lh-primary/50",
                  !variant.isAvailable && !isSelected && "opacity-50 text-lh-muted bg-lh-neutral-2",
                  !readOnly && !variant.isAvailable && !isSelected && "cursor-not-allowed",
                  readOnly && "cursor-default"
                )}
              >
                {variant.title}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
