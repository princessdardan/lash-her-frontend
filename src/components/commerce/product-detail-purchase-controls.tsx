"use client";

import { useMemo, useState, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { TProduct, TProductVariant } from "@/types";
import { ProductVariantSelector } from "./product-variant-selector";
import { useProductCart } from "./product-cart-provider";

const MIN_QUANTITY = 1;
const MAX_QUANTITY = 10;

interface ProductDetailPurchaseControlsProps {
  readonly product: TProduct;
}

function clampQuantity(value: number): number {
  if (!Number.isFinite(value)) return MIN_QUANTITY;
  return Math.max(MIN_QUANTITY, Math.min(MAX_QUANTITY, Math.trunc(value)));
}

function getRequiredOptionNames(product: TProduct, variants: TProductVariant[]): string[] {
  const names = [
    ...(product.optionGroups?.map((group) => group.name) ?? []),
    ...variants.flatMap((variant) => variant.options?.map((option) => option.name) ?? []),
  ];

  return Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
}

function variantMatchesSelectedOptions(variant: TProductVariant, selectedOptions: Readonly<Record<string, string>>): boolean {
  return Object.entries(selectedOptions).every(([name, value]) => {
    if (!value) return true;
    return variant.options?.some((option) => option.name === name && option.value === value);
  });
}

export function ProductDetailPurchaseControls({ product }: ProductDetailPurchaseControlsProps): ReactElement {
  const router = useRouter();
  const { addItem, openCart } = useProductCart();
  const variants = useMemo(() => product.variants?.filter((variant) => variant.title) ?? [], [product.variants]);
  const requiredOptionNames = useMemo(() => getRequiredOptionNames(product, variants), [product, variants]);
  const [selectedVariantId, setSelectedVariantId] = useState("");
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState(MIN_QUANTITY);

  const selectedVariant = variants.find((variant) => variant._key === selectedVariantId);
  const hasVariants = variants.length > 0;
  const hasCompleteOptions = requiredOptionNames.every((name) => Boolean(selectedOptions[name]));
  const selectedVariantMatchesOptions = selectedVariant ? variantMatchesSelectedOptions(selectedVariant, selectedOptions) : false;
  const hasRequiredVariantSelection = !hasVariants || Boolean(
    selectedVariant?.isAvailable &&
    selectedVariantMatchesOptions &&
    (requiredOptionNames.length === 0 || hasCompleteOptions),
  );
  const canPurchase = product.isAvailable && hasRequiredVariantSelection;
  const selectionMessageId = `${product._id}-purchase-selection-message`;
  const quantityLabelId = `${product._id}-quantity-label`;

  const itemPayload = {
    productId: product._id,
    ...(selectedVariant ? { variantId: selectedVariant._key } : {}),
    quantity,
  };

  const handleVariantSelect = (variant: TProductVariant) => {
    setSelectedVariantId(variant._key);
    setSelectedOptions((currentOptions) => ({
      ...currentOptions,
      ...(variant.options?.reduce<Record<string, string>>((options, option) => {
        options[option.name] = option.value;
        return options;
      }, {}) ?? {}),
    }));
  };

  const handleOptionsChange = (nextOptions: Record<string, string>) => {
    setSelectedOptions(nextOptions);
    setSelectedVariantId("");
  };

  const handleAddToCart = () => {
    if (!canPurchase) return;

    addItem(itemPayload);
    openCart();
  };

  const handleBuyNow = () => {
    if (!canPurchase) return;

    const params = new URLSearchParams({
      buyNow: "1",
      productId: product._id,
      quantity: String(quantity),
    });

    if (selectedVariant) {
      params.set("variantId", selectedVariant._key);
    }

    router.push(`/checkout?${params.toString()}`);
  };

  const handleQuantityChange = (value: string) => {
    setQuantity(clampQuantity(Number(value)));
  };

  return (
    <div className="mt-8 border-t border-lh-line pt-6">
      <ProductVariantSelector
        product={product}
        selectedOptions={selectedOptions}
        selectedVariantId={selectedVariantId}
        onOptionsChange={handleOptionsChange}
        onVariantSelect={handleVariantSelect}
      />

      <div className="mt-8 rounded-[24px] border border-lh-line bg-lh-neutral-2/70 p-5 md:p-6">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <label className="block md:w-32" htmlFor={`${product._id}-quantity`}>
            <span id={quantityLabelId} className="eyebrow-label mb-2 block">Quantity</span>
            <Input
              id={`${product._id}-quantity`}
              type="number"
              min={MIN_QUANTITY}
              max={MAX_QUANTITY}
              inputMode="numeric"
              value={quantity}
              onChange={(event) => handleQuantityChange(event.target.value)}
              aria-labelledby={quantityLabelId}
              disabled={!product.isAvailable}
            />
          </label>

          <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
            <Button
              type="button"
              onClick={handleAddToCart}
              disabled={!canPurchase}
              aria-describedby={selectionMessageId}
              className={cn(
                "h-12 rounded-full px-6 font-body text-sm uppercase tracking-[0.12em]",
                canPurchase ? "bg-lh-primary text-lh-white hover:bg-lh-accent" : "bg-lh-neutral text-lh-muted",
              )}
            >
              Add to Cart
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={handleBuyNow}
              disabled={!canPurchase}
              aria-describedby={selectionMessageId}
              className="h-12 rounded-full border-lh-primary/30 px-6 font-body text-sm uppercase tracking-[0.12em] hover:bg-lh-primary-soft hover:text-lh-primary"
            >
              Buy Now
            </Button>
          </div>
        </div>

        <p
          id={selectionMessageId}
          role="status"
          aria-live="polite"
          className={cn(
            "mt-4 font-body text-xs font-bold leading-6",
            canPurchase ? "text-lh-muted" : "text-lh-accent",
          )}
        >
          {canPurchase
            ? "Ready for secure checkout. Add this selection to the cart or start a single-item checkout."
            : hasVariants
              ? "Choose an available product option before adding this item to cart or buying now."
              : product.availabilityLabel || "This product is currently unavailable."}
        </p>
      </div>
    </div>
  );
}
