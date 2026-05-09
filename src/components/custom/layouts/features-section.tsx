import React from "react";
import type { TFeaturesSection, TFeature } from "@/types";
import { EyeClosedIcon, SparklesIcon, StarIcon } from "lucide-react";

export type { TFeaturesSection as IFeaturesSectionProps } from "@/types";

function getIcon(name: string) {
  switch (name) {
    case "EYE_ICON":
      return <EyeClosedIcon className="w-4 h-4 text-current" aria-hidden="true" />;
    case "SPARKLES_ICON":
      return <SparklesIcon className="w-4 h-4 text-current" aria-hidden="true" />;
    case "STAR_ICON":
      return <StarIcon className="w-4 h-4 text-current" aria-hidden="true" />;
    default:
      return null;
  }
}


export function FeaturesSection({ data }: { data: TFeaturesSection }) {
  if (!data?.features) return null;
  return (
    <section className="section-shell">
      <div className="content-container">
        {/* Section Header */}
        <div className="text-container text-center mb-16">
          <h2 className="section-heading">{data.heading}</h2>
          <p className="font-heading text-lh-primary text-xl md:text-2xl lg:text-3xl mt-4">{data.subHeading}</p>
          {data.description && (
            <p className="mx-auto mt-6 max-w-2xl text-lh-shadow/80 leading-relaxed">{data.description}</p>
          )}
        </div>

        {/* Features Grid */}
        <div className="grid gap-10 md:grid-cols-3 max-w-6xl mx-auto">
          {data.features.map((item: TFeature, index: number) => (
            <div
              key={item._key || index}
              className="editorial-card flex flex-col items-center text-center p-8"
            >
              {/* Icon */}
              <div className="mb-6 text-lh-primary p-4 rounded-full bg-lh-primary-soft">
                {getIcon(item.icon)}
              </div>

              {/* Feature Content */}
              <h3 className="mb-4 text-2xl font-heading text-lh-shadow">{item.heading}</h3>
              <div className="w-12 h-[1px] bg-lh-light mb-4" />
              <p className="max-w-sm mt-auto text-lh-shadow/80 leading-relaxed">{item.subHeading}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
