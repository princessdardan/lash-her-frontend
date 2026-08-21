"use client";

import { useMemo, type ReactElement } from "react";
import { SanityImage } from "@/components/ui/sanity-image";
import type { TProduct, TSanityImage } from "@/types";
import { useProductGallery } from "./product-gallery-context";

interface ProductDetailGalleryProps {
  readonly product: TProduct;
  readonly availabilityLabel: string;
}

function getBaseImages(product: TProduct): TSanityImage[] {
  const gallery = product.gallery ?? [];
  return product.image ? [product.image, ...gallery] : gallery;
}

export function ProductDetailGallery({
  product,
  availabilityLabel,
}: ProductDetailGalleryProps): ReactElement {
  const { activeVariantImage } = useProductGallery();
  const baseImages = useMemo(() => getBaseImages(product), [product]);

  // The selected variant's image takes over the hero; the product's own photos
  // stay reachable as thumbnails so shoppers can still browse them.
  const heroImage = activeVariantImage ?? baseImages[0] ?? null;
  const thumbnailSource = activeVariantImage ? baseImages : baseImages.slice(1);
  const thumbnails = thumbnailSource
    .filter((image) => image.asset._ref !== heroImage?.asset._ref)
    .slice(0, 4);

  return (
    <div className="space-y-5">
      <div className="relative min-h-[520px] overflow-hidden rounded-[28px] border border-lh-line bg-lh-shadow shadow-[0_24px_70px_rgba(28,19,24,0.10)] md:min-h-[660px]">
        {heroImage ? (
          <SanityImage
            key={heroImage.asset._ref}
            image={heroImage}
            alt={
              heroImage.alt ||
              (activeVariantImage
                ? `${product.title} selected option`
                : product.title)
            }
            fill
            priority
            sizes="(min-width: 1024px) 54vw, 100vw"
            className="object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_72%_18%,var(--lh-light-soft),transparent_32%),linear-gradient(135deg,var(--lh-shadow),var(--lh-accent)_52%,var(--lh-primary))]" />
        )}
        <div
          className="absolute inset-0 bg-gradient-to-t from-lh-shadow/65 via-lh-shadow/10 to-transparent"
          aria-hidden="true"
        />
        <div className="absolute left-5 top-5 flex flex-wrap gap-2 md:left-7 md:top-7">
          {product.badgeLabel ? (
            <span className="rounded-full bg-lh-light px-4 py-2 font-body text-xs font-bold uppercase tracking-[0.14em] text-lh-shadow">
              {product.badgeLabel}
            </span>
          ) : null}
          {!product.isAvailable ? (
            <span className="rounded-full bg-lh-accent px-4 py-2 font-body text-xs font-bold uppercase tracking-[0.14em] text-lh-white">
              {availabilityLabel}
            </span>
          ) : null}
        </div>
      </div>

      {thumbnails.length > 0 && (
        <section
          className="grid grid-cols-2 gap-4 md:grid-cols-4"
          aria-label="Product gallery"
        >
          {thumbnails.map((image, index) => (
            <div
              key={`${image.asset._ref}-${index}`}
              className="relative min-h-36 overflow-hidden rounded-[24px] border border-lh-line bg-lh-white shadow-[0_18px_50px_rgba(28,19,24,0.05)] md:min-h-44"
            >
              <SanityImage
                image={image}
                alt={image.alt || `${product.title} gallery image ${index + 2}`}
                fill
                sizes="(min-width: 1024px) 14vw, 50vw"
                className="object-cover"
              />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
