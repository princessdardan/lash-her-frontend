"use client";

import { useMemo, useState, type ReactElement } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SanityImage } from "@/components/ui/sanity-image";
import { cn } from "@/lib/utils";
import { formatCad } from "@/lib/commerce/money";
import type { TProduct, TProductVariant } from "@/types";

interface ProductCardProps {
  product: TProduct;
  onAdd?: (product: TProduct, variant?: TProductVariant) => void;
}

const PRICE_UNAVAILABLE_LABEL = "Price unavailable";

function formatDisplayPrice(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return PRICE_UNAVAILABLE_LABEL;
  }

  try {
    return formatCad(value);
  } catch {
    return PRICE_UNAVAILABLE_LABEL;
  }
}

function getDiscountedPrice(price: unknown, discountPrice: unknown): number | null {
  if (typeof price !== "number" || !Number.isFinite(price)) return null;
  if (typeof discountPrice !== "number" || !Number.isFinite(discountPrice)) return null;

  return discountPrice < price ? discountPrice : null;
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
  const discountPrice = selectedVariant?.discountPrice ?? product.discountPrice;
  const effectiveDiscountPrice = getDiscountedPrice(price, discountPrice);
  const canAdd = product.isAvailable && (variants.length === 0 || Boolean(selectedVariant?.isAvailable));
  const availabilityLabel = product.availabilityLabel || (product.isAvailable ? "Ready to ship" : "Unavailable");

  return (
    <article className="editorial-card group min-h-[560px] overflow-hidden p-0">
      <Link
        href={productHref}
        className="relative block min-h-72 overflow-hidden bg-lh-primary-soft focus-visible:outline-lh-primary"
        aria-label={`View ${product.title}`}
      >
        {product.image ? (
          <SanityImage
            image={product.image}
            alt={product.image.alt || product.title}
            fill
            sizes="(min-width: 1280px) 25vw, (min-width: 768px) 50vw, 100vw"
            className="object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_78%_18%,var(--lh-light-soft),transparent_32%),linear-gradient(135deg,var(--lh-neutral-2),var(--lh-neutral))]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-lh-shadow/70 via-lh-shadow/10 to-transparent" aria-hidden="true" />
        <div className="absolute left-5 top-5 flex flex-wrap gap-2">
          {product.badgeLabel ? (
            <span className="rounded-full bg-lh-light px-3 py-1 font-body text-xs font-bold uppercase tracking-[0.12em] text-lh-shadow">
              {product.badgeLabel}
            </span>
          ) : null}
          {!product.isAvailable ? (
            <span className="rounded-full bg-lh-accent px-3 py-1 font-body text-xs font-bold uppercase tracking-[0.12em] text-lh-white">
              {availabilityLabel}
            </span>
          ) : null}
        </div>
      </Link>

      <div className="flex flex-1 flex-col p-6 md:p-7">
        <div className="mb-4">
          <p className="eyebrow-label mb-2">Product</p>
          <h3 className="section-subheading text-3xl leading-none md:text-4xl">
            <Link href={productHref} className="transition-colors hover:text-lh-primary">
              {product.title}
            </Link>
          </h3>
          {product.cardSubtitle ? (
            <p className="mt-3 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-primary">
              {product.cardSubtitle}
            </p>
          ) : null}
        </div>

        <p className="mb-5 flex-1 font-body text-sm font-bold leading-7 text-lh-shadow/76 md:text-base">
          {product.shortDescription || product.description}
        </p>

        <div className="mb-5 flex flex-wrap gap-2">
          {product.isAvailable ? (
            <span className="rounded-full border border-lh-line px-3 py-1 font-body text-xs font-bold uppercase tracking-[0.12em] text-lh-muted">
              {availabilityLabel}
            </span>
          ) : null}
          {product.collections?.slice(0, 2).map((collection) => (
            <span key={collection._id} className="rounded-full border border-lh-line px-3 py-1 font-body text-xs font-bold uppercase tracking-[0.12em] text-lh-shadow/70">
              {collection.title}
            </span>
          ))}
        </div>

        {product.fulfillmentNote ? (
          <p className="mb-5 border-l-2 border-lh-light pl-3 font-body text-xs font-bold leading-6 text-lh-muted">
            {product.fulfillmentNote}
          </p>
        ) : null}

        {variants.length > 0 && (
          <label className="mb-5 block">
            <span className="eyebrow-label mb-2 block">Choose option</span>
            <select
              value={selectedVariantId}
              onChange={(event) => setSelectedVariantId(event.target.value)}
              className="form-input"
              disabled={!product.isAvailable}
            >
              {availableVariants.length === 0 && (
                <option value="" disabled>
                  No options available
                </option>
              )}
              {variants.map((variant) => (
                <option key={variant._key} value={variant._key} disabled={!variant.isAvailable}>
                  {variant.title} - {formatDisplayPrice(getDiscountedPrice(variant.price, variant.discountPrice) ?? variant.price)}
                  {!variant.isAvailable ? ` - ${variant.availabilityLabel || "Unavailable"}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="mt-auto rounded-[24px] border border-lh-line bg-lh-neutral-2/70 p-4">
          <div className="mb-4 flex items-center justify-between gap-4">
            <span className="font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-muted">Price</span>
            <span className="flex flex-col items-end gap-1 font-body text-xl font-bold text-lh-shadow">
              {effectiveDiscountPrice !== null ? (
                <span className="text-sm text-lh-muted line-through">{formatDisplayPrice(price)}</span>
              ) : null}
              <span>{formatDisplayPrice(effectiveDiscountPrice ?? price)}</span>
            </span>
          </div>
          {onAdd ? (
            <Button
              type="button"
              onClick={() => onAdd(product, selectedVariant)}
              disabled={!canAdd}
              aria-label={canAdd ? `Add to Cart: ${product.title}` : `${product.title} ${availabilityLabel}`}
              className={cn(
                "w-full rounded-full px-6 py-3 uppercase tracking-[0.12em]",
                canAdd ? "bg-lh-primary text-lh-white hover:bg-lh-accent" : "bg-lh-neutral text-lh-muted",
              )}
            >
              {canAdd ? "Add to Cart" : availabilityLabel}
            </Button>
          ) : (
            <Button asChild className="w-full rounded-full bg-lh-primary px-6 py-3 uppercase tracking-[0.12em] text-lh-white hover:bg-lh-accent">
              <Link href={productHref} aria-label={`View details for ${product.title}`}>
                View Details
              </Link>
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
