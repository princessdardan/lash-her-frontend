"use client";

import { useState } from "react";
import { SanityImage } from "@/components/ui/sanity-image";
import type { TTrainingProgramDetailItem } from "@/types";

interface TrainingDetailItemsProps {
  items: TTrainingProgramDetailItem[];
}

export function TrainingDetailItems({ items }: TrainingDetailItemsProps) {
  const [activeIndex, setActiveIndex] = useState(0);

  if (!items || items.length === 0) return null;

  const activeItem = items[activeIndex];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12 my-12">
      <div className="flex flex-col gap-4" role="tablist" aria-label="Training Details">
        {items.map((item, index) => {
          const isActive = index === activeIndex;
          return (
            <button
              key={item._key || index}
              role="tab"
              aria-selected={isActive}
              aria-controls={`detail-panel-${index}`}
              id={`detail-tab-${index}`}
              onClick={() => setActiveIndex(index)}
              className={`text-left p-6 rounded-2xl transition-all duration-300 ${
                isActive 
                  ? "bg-lh-shadow text-lh-neutral-2 shadow-lg" 
                  : "bg-lh-neutral/30 text-lh-shadow hover:bg-lh-neutral/50"
              }`}
            >
              <h3 className="text-xl font-serif font-medium mb-2">{item.title}</h3>
              <div 
                className={`grid transition-all duration-300 ease-in-out ${
                  isActive ? "grid-rows-[1fr] opacity-100 mt-2" : "grid-rows-[0fr] opacity-0"
                }`}
              >
                <p className="overflow-hidden text-sm leading-relaxed opacity-90">
                  {item.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      <div 
        className="relative aspect-square lg:aspect-auto lg:h-full rounded-2xl overflow-hidden bg-lh-neutral/20"
        role="tabpanel"
        id={`detail-panel-${activeIndex}`}
        aria-labelledby={`detail-tab-${activeIndex}`}
      >
        {activeItem?.image ? (
          <SanityImage
            image={activeItem.image}
            alt={activeItem.image.alt || activeItem.title}
            fill
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
