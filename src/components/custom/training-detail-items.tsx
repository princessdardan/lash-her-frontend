"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SanityImage } from "@/components/ui/sanity-image";
import type { TTrainingProgramDetailItem } from "@/types";
import { cn } from "@/lib/utils";

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

  const validItems = useMemo(() => items.filter((item) => item.title || item.description || item.image), [items]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateReducedMotion = () => setPrefersReducedMotion(mediaQuery.matches);

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
        const nextProgress = currentProgress + (DETAIL_PROGRESS_STEP_MS / DETAIL_ROTATION_MS) * 100;

        if (nextProgress >= 100) {
          setActiveIndex((currentIndex) => ((currentIndex >= validItems.length ? 0 : currentIndex) + 1) % validItems.length);
          return 0;
        }

        return nextProgress;
      });
    }, DETAIL_PROGRESS_STEP_MS);

    return () => window.clearInterval(interval);
  }, [isPaused, prefersReducedMotion, validItems.length]);

  if (validItems.length === 0) return null;

  const effectiveActiveIndex = activeIndex >= validItems.length ? 0 : activeIndex;
  const activeItem = validItems[effectiveActiveIndex];

  return (
    <div
      className="my-12 grid grid-cols-1 gap-6 lg:my-16 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.35fr)] lg:gap-8 xl:gap-10"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocusCapture={() => setIsPaused(true)}
      onBlurCapture={() => setIsPaused(false)}
      data-training-detail-items="true"
    >
      <div className="flex flex-col gap-4 lg:gap-5" role="tablist" aria-label="Training Details">
        {validItems.map((item, index) => {
          const isActive = index === effectiveActiveIndex;
          return (
            <button
              key={item._key || index}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-current={isActive ? "true" : undefined}
              aria-controls={`detail-panel-${index}`}
              id={`detail-tab-${index}`}
              onClick={() => activateItem(index)}
              className={cn(
                "group relative overflow-hidden rounded-[24px] border p-6 text-left transition-all duration-300 md:p-7 lg:p-8",
                isActive
                  ? "border-lh-light/70 bg-lh-shadow text-lh-neutral-2 shadow-[0_24px_70px_rgba(28,19,24,0.14)]"
                  : "border-lh-line bg-lh-neutral-2/70 text-lh-shadow hover:border-lh-primary/30 hover:bg-lh-neutral",
              )}
              data-training-detail-card={isActive ? "active" : "inactive"}
            >
              <span className={cn("mb-4 inline-flex text-xs font-bold uppercase tracking-[0.24em]", isActive ? "text-lh-light" : "text-lh-primary")}>Lesson {index + 1}</span>
              <h3 className="font-heading text-2xl font-normal leading-tight md:text-3xl">{item.title}</h3>
              <div 
                className={cn(
                  "grid transition-all duration-300 ease-in-out",
                  isActive ? "mt-4 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                )}
              >
                <p className="overflow-hidden text-sm font-bold leading-7 opacity-90 md:text-base">
                  {item.description}
                </p>
              </div>
              <span
                className={cn("absolute bottom-0 left-0 h-1 bg-lh-light transition-opacity", isActive ? "opacity-100" : "opacity-0")}
                style={{ width: `${isActive ? progress : 0}%` }}
                aria-hidden="true"
                data-training-detail-progress="true"
              />
            </button>
          );
        })}
      </div>

      <div 
        className="relative min-h-[420px] overflow-hidden rounded-[28px] border border-lh-line bg-lh-neutral/20 shadow-[0_24px_70px_rgba(28,19,24,0.08)] md:min-h-[560px] lg:min-h-full"
        role="tabpanel"
        id={`detail-panel-${effectiveActiveIndex}`}
        aria-labelledby={`detail-tab-${effectiveActiveIndex}`}
        data-training-detail-image="true"
      >
        {activeItem?.image ? (
          <SanityImage
            image={activeItem.image}
            alt={activeItem.image.alt || activeItem.title}
            fill
            sizes="(min-width: 1024px) 48vw, 100vw"
            className="object-cover transition-opacity duration-500"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-lh-shadow/40 font-serif italic">
            No image available
          </div>
        )}
      </div>
    </div>
  );
}
