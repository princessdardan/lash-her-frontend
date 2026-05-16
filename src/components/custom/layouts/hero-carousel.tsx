"use client";

import { useState, useEffect, useCallback } from "react";
import type { THeroSection } from "@/types";
import Link from "next/link";
import { SanityImage } from "../../ui/sanity-image";
import { Button } from "../../ui/button";
import { cn } from "@/lib/utils";
import { getSafeHref, getSafeLinks } from "./hero-links";

function getCarouselInterval(value?: number) {
  return Math.min(15000, Math.max(3000, value ?? 5000));
}

interface HeroCarouselProps {
  data: THeroSection;
  containerClasses: string;
  overlayClasses: string;
  contentClasses: string;
  isHomepageStyle: boolean;
}

export function HeroCarousel({ data, containerClasses, overlayClasses, contentClasses, isHomepageStyle }: HeroCarouselProps) {
  const { slides, autoRotate, rotationIntervalMs } = data;
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  const validSlides = slides?.filter((slide) => slide.image?.asset) || [];
  const shouldAutoRotate = Boolean(autoRotate && !isPaused && validSlides.length > 1);
  
  const nextSlide = useCallback(() => {
    setCurrentIndex((prev) => (prev + 1) % validSlides.length);
  }, [validSlides.length]);

  useEffect(() => {
    if (!shouldAutoRotate) return;
    
    const interval = setInterval(nextSlide, getCarouselInterval(rotationIntervalMs));
    return () => clearInterval(interval);
  }, [nextSlide, rotationIntervalMs, shouldAutoRotate]);

  if (validSlides.length === 0) return null;

  return (
    <section className={containerClasses}>
      {validSlides.map((slide, index) => {
        const isActive = index === currentIndex;
        return (
          <div
            key={slide._key || index}
            aria-hidden={!isActive}
            inert={!isActive || undefined}
            className={cn(
              "absolute inset-0 transition-opacity duration-1000 ease-in-out",
              isActive ? "opacity-100 z-10" : "pointer-events-none opacity-0 z-0"
            )}
          >
            <SanityImage
              image={slide.image}
              alt={slide.image.alt || slide.heading || "Hero slide image"}
              className="absolute inset-0 object-cover w-full h-full"
              height={2160}
              width={3840}
              priority={index === 0}
            />
            <div className={cn("absolute inset-0", overlayClasses)} />
            <div className={contentClasses}>
              {slide.heading && (
                <h1 className={cn("display-heading text-lh-neutral-2", isHomepageStyle && "max-w-[880px]")}>
                  {slide.heading}
                </h1>
              )}
              {slide.subHeading && (
                <p className={cn("font-body text-base font-bold leading-8 text-lh-neutral-2/90 md:text-lg lg:text-xl", isHomepageStyle ? "mt-8 max-w-3xl" : "mt-6 max-w-3xl")}>
                  {slide.subHeading}
                </p>
              )}
              {slide.description && (
                <p className={cn("font-body text-base font-bold leading-8 text-lh-neutral-2/80 lg:text-lg", isHomepageStyle ? "mt-6 max-w-2xl" : "mt-6 max-w-2xl")}>
                  {slide.description}
                </p>
              )}
              {getSafeLinks(slide.link).length > 0 && (
                <div className={cn("flex flex-col md:flex-row gap-4", isHomepageStyle ? "mt-10" : "mt-8")}>
                  {getSafeLinks(slide.link).map((btn, btnIndex) => (
                    <Link
                      key={btn._key || btnIndex}
                      href={getSafeHref(btn.href) ?? "/"}
                      target={btn.isExternal ? "_blank" : undefined}
                      rel={btn.isExternal ? "noopener noreferrer" : undefined}
                    >
                      <Button 
                        variant={btnIndex === 0 ? (isHomepageStyle ? "luxury" : "primary") : "ghost"} 
                        className={btnIndex !== 0 ? "text-lh-neutral-2 border-lh-neutral-2/40 hover:bg-lh-neutral-2/10" : ""}
                      >
                        {btn.label}
                      </Button>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
      
      {validSlides.length > 1 && (
        <div className="absolute bottom-8 left-0 right-0 z-20 flex items-center justify-center gap-3">
          {validSlides.map((_, index) => (
            <button
              key={index}
              onClick={() => {
                setCurrentIndex(index);
                setIsPaused(true);
              }}
              className={cn(
                "w-2.5 h-2.5 rounded-full transition-all duration-300",
                index === currentIndex ? "bg-lh-neutral-2 w-8" : "bg-lh-neutral-2/50 hover:bg-lh-neutral-2/80"
              )}
              aria-label={`Go to slide ${index + 1}`}
            />
          ))}
          {autoRotate && (
            <button
              type="button"
              onClick={() => setIsPaused((paused) => !paused)}
              className="ml-2 rounded-full border border-lh-neutral-2/60 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-lh-neutral-2 transition-colors hover:bg-lh-neutral-2/10"
              aria-label={isPaused ? "Resume hero carousel" : "Pause hero carousel"}
            >
              {isPaused ? "Play" : "Pause"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
