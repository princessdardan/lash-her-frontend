
import type { TCtaFeaturesSection, TCtaFeature } from "@/types";
import { AwardIcon, UserIcon, UsersIcon, VideoIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PortableTextRenderer } from "@/components/ui/portable-text-renderer";

export type { TCtaFeaturesSection as CtaFeaturesSectionProps } from "@/types";
export type { TCtaFeature as CtaFeature } from "@/types";

function getIcon(name: string) {
  switch (name) {
    case "VIDEO_ICON":
      return <VideoIcon className="w-4 h-4 text-current" aria-hidden="true" />;
    case "USER_ICON":
      return <UserIcon className="w-4 h-4 text-current" aria-hidden="true" />;
    case "USERS_ICON":
      return <UsersIcon className="w-4 h-4 text-current" aria-hidden="true" />;
    case "AWARD_ICON":
      return <AwardIcon className="w-4 h-4 text-current" aria-hidden="true" />;
    default:
      return null;
  }
}

export async function CtaFeaturesSection({data}: { data: TCtaFeaturesSection }) {
  if (!data) return null;
  return (
    <section className= "section-shell">
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
        <div className={`grid items-stretch gap-8 max-w-6xl mx-auto ${
          data.features.length === 1 ? 'grid-cols-1 max-w-md' :
          data.features.length === 2 ? 'md:grid-cols-2 max-w-4xl' :
          data.features.length === 4 ? 'md:grid-cols-2 lg:grid-cols-4' :
          'md:grid-cols-2 lg:grid-cols-3'
        }`}>
          {data.features.map((item: TCtaFeature, index: number) => (
            <div
              key={item._key || index}
              className={`editorial-card relative flex h-full min-h-[480px] w-full flex-col self-stretch p-8 ${
                item.mostPopular ? "border-lh-light border-2 shadow-md" : ""
              }`}
            >
              {/* Most Popular Badge */}
              {item.mostPopular && (
                <div className="absolute top-0 right-0 bg-lh-light text-lh-shadow text-xs px-4 py-1.5 rounded-bl-[18px] rounded-tr-[16px] font-heading tracking-widest uppercase font-bold">
                  Most Popular
                </div>
              )}

              {/* Feature Header */}
              <div className="mb-6">
                <div className="flex items-start mb-6">
                  <div className={`rounded-full bg-lh-primary-soft p-3 inline-flex items-center justify-center text-lh-primary ${
                    item.mostPopular ? "bg-lh-primary text-lh-white" : ""
                  }`}>
                    {getIcon(item.icon)}
                  </div>
                </div>
                <h3 className="text-3xl font-heading text-lh-shadow mb-2">{item.heading}</h3>
                <p className="text-sm text-lh-primary font-heading tracking-widest uppercase mb-4">{item.subHeading}</p>
                <div className="w-12 h-[1px] bg-lh-light mb-4" />
                <div className="text-sm font-bold text-lh-shadow/70">
                  {item.location}
                </div>
              </div>
              <div className="text-sm text-lh-primary font-heading tracking-widest uppercase mb-6">{item.tier}</div>
              
              {/* Rich Text Content */}
              <div className="flex-grow mb-8 text-lh-shadow/80 leading-relaxed">
                <PortableTextRenderer content={item.features} />
              </div>

              {/* CTA Link */}
              {item.link && (
                <Link
                  href={item.link.href}
                  target={item.link.isExternal ? "_blank" : undefined}
                  rel={
                    item.link.isExternal ? "noopener noreferrer" : undefined
                  }
                  className="mt-auto"
                >
                  <Button variant={item.mostPopular ? "primary" : "outline"} className="w-full">
                    {item.link.label}
                  </Button>
                </Link>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
