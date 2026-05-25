"use client";

import { useState, useEffect, useCallback } from "react";
import type { TFeatureSection, TFeatureItem, TProduct } from "@/types";
import { SanityImage } from "@/components/ui/sanity-image";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

export type { TFeatureSection as IFeatureSectionProps } from "@/types";

interface FeatureSectionProps {
  data: TFeatureSection;
  products?: TProduct[];
}

type ResolvedFeatureProduct = Pick<
  TProduct,
  "_id" | "title" | "slug" | "shortDescription" | "description" | "cardSubtitle" | "image"
>;

type FeatureProductReference = { _type: "reference"; _ref: string };

function isFeatureProductReference(product: TFeatureItem["product"]): product is FeatureProductReference {
  return Boolean(product && "_ref" in product);
}

function isResolvedFeatureProduct(product: TFeatureItem["product"]): product is ResolvedFeatureProduct {
  return Boolean(product && "_id" in product && "slug" in product);
}

function getFeatureProduct(item: TFeatureItem, products?: TProduct[]): ResolvedFeatureProduct | undefined {
  const { product } = item;

  if (isResolvedFeatureProduct(product)) return product;

  if (isFeatureProductReference(product) && products) {
    const productId = product._ref;
    return products.find((product) => product._id === productId);
  }

  return undefined;
}

function resolveFeatureItem(
  item: TFeatureItem,
  products?: TProduct[]
): {
  image: TFeatureItem["image"];
  heading: string;
  subHeading?: string;
  description: string;
  linkHref: string;
  linkLabel: string;
  isExternal: boolean;
} {
  const product = getFeatureProduct(item, products);

  if (product) {
    return {
      image: product.image || item.image,
      heading: product.title || item.heading || "Featured product",
      subHeading: item.subHeading || product.cardSubtitle,
      description: product.shortDescription || product.description || item.description || "",
      linkHref: `/products/${product.slug}`,
      linkLabel: item.link?.label || "View Product",
      isExternal: false,
    };
  }

  // Fallback to explicit fields
  return {
    image: item.image,
    heading: item.heading || "Featured service",
    subHeading: item.subHeading,
    description: item.description || "",
    linkHref: item.link?.href || "#",
    linkLabel: item.link?.label || "Learn More",
    isExternal: item.link?.isExternal || false,
  };
}

function FeatureImage({
  item,
  products,
}: {
  item: TFeatureItem;
  products?: TProduct[];
}) {
  const resolved = resolveFeatureItem(item, products);

  if (!resolved.image?.asset?._ref) {
    return (
      <div className="w-full h-full min-h-[400px] bg-lh-neutral rounded-[24px] flex items-center justify-center">
        <span className="text-lh-shadow/40">No image available</span>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full min-h-[400px] lg:min-h-[500px]">
      <SanityImage
        image={resolved.image}
        alt={resolved.image.alt || resolved.heading}
        className="object-cover rounded-[24px] shadow-sm w-full h-full"
        fill
        sizes="(max-width: 1024px) 100vw, 50vw"
      />
    </div>
  );
}

function FeatureText({
  item,
  products,
}: {
  item: TFeatureItem;
  products?: TProduct[];
}) {
  const resolved = resolveFeatureItem(item, products);

  return (
    <div className="flex flex-col justify-center">
      <h2 className="text-3xl md:text-4xl lg:text-5xl font-heading text-lh-shadow mb-4">
        {resolved.heading}
      </h2>
      {resolved.subHeading && (
        <p className="text-lg md:text-xl text-lh-primary font-heading tracking-widest uppercase mb-6">
          {resolved.subHeading}
        </p>
      )}
      <div className="w-12 h-[1px] bg-lh-light mb-6" />
      <p className="text-lh-shadow/80 leading-relaxed mb-8 max-w-xl">
        {resolved.description}
      </p>
      {resolved.isExternal ? (
        <a
          href={resolved.linkHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center px-8 py-3 bg-lh-primary text-white rounded-full font-heading text-sm tracking-wider uppercase hover:bg-lh-primary/90 transition-colors w-fit"
        >
          {resolved.linkLabel}
        </a>
      ) : (
        <Link
          href={resolved.linkHref}
          className="inline-flex items-center justify-center px-8 py-3 bg-lh-primary text-white rounded-full font-heading text-sm tracking-wider uppercase hover:bg-lh-primary/90 transition-colors w-fit"
        >
          {resolved.linkLabel}
        </Link>
      )}
    </div>
  );
}

export function FeatureSection({ data, products }: FeatureSectionProps) {
  const { layout, enableCarousel, carouselIntervalMs = 5000, items } = data;
  const [currentIndex, setCurrentIndex] = useState(0);

  const hasItems = items && items.length > 0;

  const goToNext = useCallback(() => {
    if (!hasItems) return;
    setCurrentIndex((prev) => (prev + 1) % items.length);
  }, [items, hasItems]);

  const goToPrev = useCallback(() => {
    if (!hasItems) return;
    setCurrentIndex((prev) => (prev - 1 + items.length) % items.length);
  }, [items, hasItems]);

  // Auto-rotate carousel
  useEffect(() => {
    if (!enableCarousel || !hasItems || items.length <= 1) return;

    const interval = setInterval(goToNext, carouselIntervalMs);
    return () => clearInterval(interval);
  }, [enableCarousel, carouselIntervalMs, items, hasItems, goToNext]);

  if (!hasItems) return null;

  const currentItem = items[currentIndex];

  // Mobile always shows image on top, text below
  // Desktop respects the layout selection
  const isImageTop = layout === "imageTop";

  return (
    <section className="section-shell">
      <div
        className={cn(
          "mx-auto rounded-[28px] border border-lh-line bg-lh-neutral p-6 shadow-[0_18px_50px_rgba(28,19,24,0.04)] md:p-10 lg:p-14",
          isImageTop ? "max-w-4xl" : "container max-w-7xl"
        )}
      >
        {/* Carousel Navigation (only when carousel enabled and multiple items) */}
        {enableCarousel && items.length > 1 && (
          <div className="flex items-center justify-between mb-6">
            <button
              onClick={goToPrev}
              className="p-2 rounded-full bg-lh-primary hover:bg-lh-primary/50 transition-colors"
              aria-label="Previous feature"
            >
              <ChevronLeft className="w-5 h-5 text-lh-shadow" />
            </button>
            <div className="flex gap-2">
              {items.map((item, index) => (
                <button
                  key={item._key}
                  onClick={() => setCurrentIndex(index)}
                  className={cn(
                    "w-2 h-2 rounded-full transition-colors",
                    index === currentIndex
                      ? "bg-lh-primary"
                      : "bg-lh-neutral hover:bg-lh-light"
                  )}
                  aria-label={`Go to feature ${index + 1}`}
                />
              ))}
            </div>
            <button
              onClick={goToNext}
              className="p-2 rounded-full bg-lh-primary hover:bg-lh-primary/50 transition-colors"
              aria-label="Next feature"
            >
              <ChevronRight className="w-5 h-5 text-lh-shadow" />
            </button>
          </div>
        )}

        {/* Feature Content */}
        <div
          className={cn(
            "flex gap-8 lg:gap-16",
            // Mobile: always image top, text bottom
            "flex-col",
            // Desktop: respect layout
            isImageTop
              ? "lg:flex-col items-center"
              : layout === "imageLeft"
                ? "lg:flex-row items-center"
                : "lg:flex-row-reverse items-center"
          )}
        >
          {/* Image */}
          <div className={cn("w-full", isImageTop ? "" : "lg:w-1/2")}>
            <FeatureImage item={currentItem} products={products} />
          </div>

          {/* Text */}
          <div className={cn("w-full", isImageTop ? "" : "lg:w-1/2")}>
            <FeatureText item={currentItem} products={products} />
          </div>
        </div>
      </div>
    </section>
  );
}
