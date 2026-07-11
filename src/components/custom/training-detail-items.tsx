"use client";

import { PortableText, type PortableTextComponents } from "@portabletext/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TPortableTextBlock, TTrainingProgramDetailItem } from "@/types";
import { cn } from "@/lib/utils";

const detailItemDescriptionComponents: PortableTextComponents = {
  block: {
    normal: ({ children }) => <p>{children}</p>,
  },
  marks: {
    strong: ({ children }) => <strong>{children}</strong>,
    em: ({ children }) => <em>{children}</em>,
  },
  list: {
    bullet: ({ children }) => (
      <ul className="list-disc list-outside pl-5 space-y-1">{children}</ul>
    ),
    number: ({ children }) => (
      <ol className="list-decimal list-outside pl-5 space-y-1">{children}</ol>
    ),
  },
};

function hasDescription(
  description: string | TPortableTextBlock[] | undefined,
): description is string | TPortableTextBlock[] {
  if (typeof description === "string") return description.trim().length > 0;
  return (
    Array.isArray(description) &&
    description.some((block) =>
      block.children?.some((child) => child.text.trim().length > 0),
    )
  );
}

function TrainingDetailItemDescription({
  description,
}: {
  readonly description: string | TPortableTextBlock[];
}) {
  if (typeof description === "string") {
    return (
      <p className="overflow-hidden text-sm font-bold leading-7 opacity-90 md:text-base">
        {description}
      </p>
    );
  }

  return (
    <div className="overflow-hidden text-sm font-bold leading-7 opacity-90 md:text-base">
      <PortableText
        value={description}
        components={detailItemDescriptionComponents}
      />
    </div>
  );
}

const DETAIL_ROTATION_MS = 7000;
const DETAIL_PROGRESS_STEP_MS = 100;

interface TrainingDetailItemsProps {
  items: TTrainingProgramDetailItem[];
}

export function TrainingDetailItems({ items }: TrainingDetailItemsProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const carouselRef = useRef<HTMLDivElement>(null);

  const validItems = useMemo(
    () =>
      items.filter((item) => item.title || hasDescription(item.description)),
    [items],
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateReducedMotion = () =>
      setPrefersReducedMotion(mediaQuery.matches);

    updateReducedMotion();
    mediaQuery.addEventListener("change", updateReducedMotion);
    return () => mediaQuery.removeEventListener("change", updateReducedMotion);
  }, []);

  const activateItem = useCallback((index: number) => {
    setActiveIndex(index);
    setProgress(0);
  }, []);

  useEffect(() => {
    if (prefersReducedMotion || isPaused || validItems.length <= 1) return;

    const interval = window.setInterval(() => {
      setProgress((currentProgress) => {
        const nextProgress =
          currentProgress +
          (DETAIL_PROGRESS_STEP_MS / DETAIL_ROTATION_MS) * 100;

        if (nextProgress >= 100) {
          setActiveIndex(
            (currentIndex) =>
              ((currentIndex >= validItems.length ? 0 : currentIndex) + 1) %
              validItems.length,
          );
          return 0;
        }

        return nextProgress;
      });
    }, DETAIL_PROGRESS_STEP_MS);

    return () => window.clearInterval(interval);
  }, [isPaused, prefersReducedMotion, validItems.length]);

  const effectiveActiveIndex =
    activeIndex >= validItems.length ? 0 : activeIndex;

  useEffect(() => {
    if (!carouselRef.current) return;
    const activeElement =
      carouselRef.current.children.item(effectiveActiveIndex);
    if (!(activeElement instanceof HTMLElement)) return;

    const container = carouselRef.current;
    const scrollLeft =
      activeElement.offsetLeft -
      (container.clientWidth - activeElement.clientWidth) / 2;
    container.scrollTo({
      left: scrollLeft,
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  }, [effectiveActiveIndex, prefersReducedMotion]);

  if (validItems.length === 0) return null;

  return (
    <div
      className="my-12 grid grid-cols-1 gap-6 md:my-16"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocusCapture={() => setIsPaused(true)}
      onBlurCapture={() => setIsPaused(false)}
      data-training-detail-items="true"
    >
      <div
        ref={carouselRef}
        className="relative flex flex-row gap-4 overflow-x-auto snap-x snap-mandatory pb-4 [-ms-overflow-style:none] [scrollbar-width:none] md:flex-col md:overflow-x-visible md:snap-none md:pb-0 lg:gap-5 [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Training Details"
      >
        {validItems.map((item, index) => {
          const isActive = index === effectiveActiveIndex;
          return (
            <button
              key={item._key || index}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-current={isActive ? "true" : undefined}
              id={`detail-tab-${index}`}
              onClick={() => activateItem(index)}
              className={cn(
                "group relative overflow-hidden rounded-[24px] border p-6 text-left transition-all duration-300 md:p-7 lg:p-8",
                "w-[85vw] shrink-0 snap-center sm:w-[400px] md:w-auto",
                isActive
                  ? "border-lh-light/70 bg-lh-shadow text-lh-neutral-2 shadow-[0_24px_70px_rgba(28,19,24,0.14)]"
                  : "border-lh-line bg-lh-neutral-2/70 text-lh-shadow hover:border-lh-primary/30 hover:bg-lh-neutral",
              )}
              data-training-detail-card={isActive ? "active" : "inactive"}
            >
              <span
                className={cn(
                  "mb-4 inline-flex text-xs font-bold uppercase tracking-[0.24em]",
                  isActive ? "text-lh-light" : "text-lh-primary",
                )}
              >
                {item.eyelash || `Lesson ${index + 1}`}
              </span>
              <h3 className="font-heading text-2xl font-normal leading-tight md:text-3xl">
                {item.title}
              </h3>
              <div
                className={cn(
                  "grid transition-all duration-300 ease-in-out",
                  isActive
                    ? "mt-4 grid-rows-[1fr] opacity-100"
                    : "grid-rows-[0fr] opacity-0",
                )}
              >
                {hasDescription(item.description) && (
                  <TrainingDetailItemDescription
                    description={item.description}
                  />
                )}
              </div>
              <span
                className={cn(
                  "absolute bottom-0 left-0 h-1 bg-lh-light transition-opacity",
                  isActive ? "opacity-100" : "opacity-0",
                )}
                style={{ width: `${isActive ? progress : 0}%` }}
                aria-hidden="true"
                data-training-detail-progress="true"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
