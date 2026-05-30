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

type FeatureItemHeadingLevel = "h2" | "h3";

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
      <div className="flex h-full min-h-[320px] w-full items-center justify-center rounded-[22px] border border-lh-white/70 bg-lh-neutral shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] sm:min-h-[400px] lg:min-h-[500px]">
        <span className="text-lh-shadow/40">No image available</span>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-[320px] w-full overflow-hidden rounded-[22px] border border-lh-white/70 bg-lh-white shadow-[0_24px_70px_rgba(28,19,24,0.12)] sm:min-h-[400px] lg:min-h-[500px]">
      <SanityImage
        image={resolved.image}
        alt={resolved.image.alt || resolved.heading}
        className="h-full w-full object-cover"
        fill
        sizes="(max-width: 1024px) 100vw, 50vw"
      />
    </div>
  );
}

function FeatureText({
  item,
  products,
  headingLevel = "h2",
}: {
  item: TFeatureItem;
  products?: TProduct[];
  headingLevel?: FeatureItemHeadingLevel;
}) {
  const resolved = resolveFeatureItem(item, products);
  const FeatureHeading = headingLevel;

  return (
    <div className="flex flex-col justify-center px-1 sm:px-2 lg:px-0">
      <FeatureHeading className="mb-4 max-w-2xl text-4xl font-heading leading-[0.95] text-lh-shadow text-balance md:text-5xl lg:text-6xl">
        {resolved.heading}
      </FeatureHeading>
      {resolved.subHeading && (
        <p className="mb-6 max-w-xl text-base font-heading uppercase tracking-[0.24em] text-lh-primary md:text-lg">
          {resolved.subHeading}
        </p>
      )}
      <div className="mb-6 flex items-center gap-3" aria-hidden="true">
        <div className="h-px w-14 bg-lh-light" />
        <div className="h-1.5 w-1.5 rounded-full bg-lh-primary/45" />
      </div>
      <p className="mb-8 max-w-xl text-base font-bold leading-8 text-lh-muted md:text-lg">
        {resolved.description}
      </p>
      {resolved.isExternal ? (
        <a
          href={resolved.linkHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center justify-center rounded-full bg-lh-primary px-8 py-3 font-heading text-sm uppercase tracking-[0.2em] text-white shadow-[0_14px_35px_rgba(102,57,118,0.22)] transition-colors hover:bg-lh-accent"
        >
          {resolved.linkLabel}
        </a>
      ) : (
        <Link
          href={resolved.linkHref}
          className="inline-flex w-fit items-center justify-center rounded-full bg-lh-primary px-8 py-3 font-heading text-sm uppercase tracking-[0.2em] text-white shadow-[0_14px_35px_rgba(102,57,118,0.22)] transition-colors hover:bg-lh-accent"
        >
          {resolved.linkLabel}
        </Link>
      )}
    </div>
  );
}

export function FeatureSection({ data, products }: FeatureSectionProps) {
  const { heading, subHeading, layout, enableCarousel, carouselIntervalMs = 5000, items } = data;
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
  const featureItemHeadingLevel: FeatureItemHeadingLevel = heading ? "h3" : "h2";

  return (
    <section className="section-shell overflow-hidden px-4 sm:px-6 lg:px-8">
      {(heading || subHeading) && (
        <div className="text-container mx-auto max-w-3xl">
          {heading && <h2 className="section-heading text-balance">{heading}</h2>}
          {subHeading && <p className="section-description text-lg">{subHeading}</p>}
        </div>
      )}
      <div
        className={cn(
          "relative isolate mx-auto overflow-hidden rounded-[26px] border border-lh-line bg-[linear-gradient(135deg,var(--lh-neutral-2)_0%,var(--lh-neutral)_58%,rgba(212,180,131,0.22)_100%)] p-4 shadow-[0_24px_80px_rgba(28,19,24,0.08)] before:absolute before:inset-x-6 before:top-0 before:h-px before:bg-lh-white/80 after:absolute after:-right-20 after:-top-24 after:h-56 after:w-56 after:rounded-full after:bg-lh-light/25 after:blur-3xl sm:rounded-[32px] sm:p-6 md:p-10 lg:p-14",
          isImageTop ? "max-w-4xl" : "container max-w-7xl"
        )}
      >
        {/* Carousel Navigation (only when carousel enabled and multiple items) */}
        {enableCarousel && items.length > 1 && (
          <div className="relative z-10 mb-6 flex items-center justify-between">
            <button
              onClick={goToPrev}
              className="rounded-full border border-lh-line bg-lh-white/80 p-2 shadow-sm transition-colors hover:bg-lh-light-soft"
              aria-label="Previous feature"
            >
              <ChevronLeft className="h-5 w-5 text-lh-shadow" />
            </button>
            <div className="flex gap-2">
              {items.map((item, index) => (
                <button
                  key={item._key}
                  onClick={() => setCurrentIndex(index)}
                  className={cn(
                    "h-2 w-2 rounded-full transition-colors",
                    index === currentIndex
                      ? "bg-lh-primary"
                      : "bg-lh-white/80 hover:bg-lh-light"
                  )}
                  aria-label={`Go to feature ${index + 1}`}
                />
              ))}
            </div>
            <button
              onClick={goToNext}
              className="rounded-full border border-lh-line bg-lh-white/80 p-2 shadow-sm transition-colors hover:bg-lh-light-soft"
              aria-label="Next feature"
            >
              <ChevronRight className="h-5 w-5 text-lh-shadow" />
            </button>
          </div>
        )}

        {/* Feature Content */}
        <div
          className={cn(
            "relative z-10 flex gap-8 lg:gap-16",
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
            <FeatureText item={currentItem} products={products} headingLevel={featureItemHeadingLevel} />
          </div>
        </div>
      </div>
    </section>
  );
}
