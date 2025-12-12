import React from "react";
import { TFeature } from "@/types";
import { EyeClosedIcon, SparklesIcon, StarIcon } from "lucide-react";

export interface IFeaturesSectionProps {
  id: number;
  __component: string;
  title: string;
  description: string;
  heading: string;
  subHeading: string;
  features?: TFeature[] | null;
}

function getIcon(name: string) {
  switch (name) {
    case "EYE_ICON":
      return <EyeClosedIcon className="w-4 h-4 text-white" aria-hidden="true" />;
    case "SPARKLES_ICON":
      return <SparklesIcon className="w-4 h-4 text-white" aria-hidden="true" />;
    case "STAR_ICON":
      return <StarIcon className="w-4 h-4 text-white" aria-hidden="true" />;
    default:
      return null;
  }
}


export function FeaturesSection({ data }: { data: IFeaturesSectionProps }) {
  if (!data?.features) return null;
  return (
    <section className="section-container-pink">
      <div className="content-container">
        {/* Section Header */}
        <div className="text-container">
          <h2 className="section-heading-red ">{data.heading}</h2>
          <p className="font-semibold text-black text-xl md:text-2xl lg:text-3xl">{data.subHeading}</p>
          {data.description && (
            <p className="mx-auto mt-4 max-w-2xl text-brand-black">{data.description}</p>
          )}
        </div>

        {/* Features Grid */}
        <div className="grid gap-8 md:grid-cols-3 max-w-6xl mx-auto">
          {data.features.map((item: TFeature) => (
            <div
              key={item.id}
              className="rounded-lg bg-white text-brand-red my-4 p-6 shadow-sm transition-shadow hover:shadow-md flex flex-col items-center text-center"
            >
              {/* Icon */}
              <div className="icon-badge">
                {getIcon(item.icon)}
              </div>
              
              {/* Feature Content */}
              <h3 className="mb-4 text-3xl font-bold font-heading">{item.heading}</h3>
              <p className="max-w-lg mt-auto text-black">{item.subHeading}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}