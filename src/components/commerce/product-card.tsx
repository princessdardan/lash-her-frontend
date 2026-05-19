"use client";

import { useMemo, useState, type ReactElement } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SanityImage } from "@/components/ui/sanity-image";
import { formatCad } from "@/lib/commerce/money";
import type { TProduct, TProductVariant } from "@/types";

interface ProductCardProps {
  product: TProduct;
  onAdd: (product: TProduct, variant?: TProductVariant) => void;
}

export function ProductCard({ product, onAdd }: ProductCardProps): ReactElement {
  const productHref = `/products/${product.slug}`;
  const variants = useMemo(
    () => product.variants?.filter((variant) => variant.title) ?? [],
    [product.variants],
  );
  const availableVariants = variants.filter((variant) => variant.isAvailable);
  const [selectedVariantId, setSelectedVariantId] = useState(availableVariants[0]?._key ?? "");
  const selectedVariant = variants.find((variant) => variant._key === selectedVariantId);
  const price = selectedVariant?.price ?? product.price;
  const canAdd = product.isAvailable && (variants.length === 0 || Boolean(selectedVariant?.isAvailable));
  const addLabel = product.isAvailable
    ? variants.length > 0 ? "Add Option" : "Add to Cart"
    : (product.availabilityLabel || "Sold Out");

  return (
    <article className="card-white flex flex-col h-full">
      {product.image && (
        <Link
          href={productHref}
          className="relative w-full aspect-square mb-4 overflow-hidden rounded-md bg-lh-neutral-2 block"
          aria-label={`View ${product.title}`}
        >
          <SanityImage
            image={product.image}
            alt={product.title}
            fill
            className="object-cover"
          />
        </Link>
      )}
      <div className="flex-1 flex flex-col">
        <div className="text-xs font-bold uppercase tracking-wider text-lh-primary mb-1">
          Product
        </div>
        <h3 className="card-heading-red text-xl mb-2">
          <Link href={productHref} className="hover:underline">
            {product.title}
          </Link>
        </h3>
        <p className="text-sm text-black font-light mb-4 flex-1">
          {product.shortDescription || product.description}
        </p>

        {product.availabilityLabel && product.isAvailable && (
          <p className="text-xs font-bold text-lh-primary mb-2">
            {product.availabilityLabel}
          </p>
        )}

        {product.fulfillmentNote && (
          <p className="text-xs text-lh-muted italic mb-4">
            {product.fulfillmentNote}
          </p>
        )}

        {variants.length > 0 && (
          <label className="mb-4 block">
            <span className="text-xs font-bold uppercase tracking-wider text-lh-primary mb-2 block">
              Choose option
            </span>
            <select
              value={selectedVariantId}
              onChange={(event) => setSelectedVariantId(event.target.value)}
              className="form-input text-sm"
              disabled={!product.isAvailable}
            >
              {availableVariants.length === 0 && (
                <option value="" disabled>
                  No options available
                </option>
              )}
              {variants.map((variant) => (
                <option key={variant._key} value={variant._key} disabled={!variant.isAvailable}>
                  {variant.title} — {formatCad(variant.price)}
                  {!variant.isAvailable ? ` - ${variant.availabilityLabel || "Unavailable"}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="flex items-center justify-between mt-auto pt-4 border-t border-lh-line">
          <span className="font-bold text-lg text-black">
            {formatCad(price)}
          </span>
          <Button
            onClick={() => onAdd(product, selectedVariant)}
            disabled={!canAdd}
            className="btn-primary-red w-auto px-6"
          >
            {addLabel}
          </Button>
        </div>
      </div>
    </article>
  );
}
