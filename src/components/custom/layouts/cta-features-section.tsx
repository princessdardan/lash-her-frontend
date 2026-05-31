
import type { TCtaFeaturesSection, TCtaFeature } from "@/types";
import { AwardIcon, UserIcon, UsersIcon, VideoIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PortableTextRenderer } from "@/components/ui/portable-text-renderer";
import { SanityImage } from "@/components/ui/sanity-image";

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
        <header className="text-container text-center mb-16">
          <h2 className="section-heading">{data.heading}</h2>
          <p className="font-heading text-lh-primary text-xl md:text-2xl lg:text-3xl mt-4">{data.subHeading}</p>
          {data.description && (
            <p className="mx-auto mt-6 max-w-2xl text-lh-shadow/80 leading-relaxed">{data.description}</p>
          )}
        </header>

        {/* Features Grid */}
        <div className={`grid items-stretch gap-8 max-w-6xl mx-auto ${
          data.features.length === 1 ? 'grid-cols-1 max-w-md' :
          data.features.length === 2 ? 'md:grid-cols-2 max-w-4xl' :
          data.features.length === 4 ? 'md:grid-cols-2 lg:grid-cols-4' :
          'md:grid-cols-2 lg:grid-cols-3'
        }`}>
          {data.features.map((item: TCtaFeature, index: number) => (
            item.format === "imageFeature" ? (
              <article
                key={item._key || index}
                className={`editorial-card relative flex h-full min-h-[480px] w-full flex-col self-stretch overflow-hidden ${
                  item.mostPopular ? "border-lh-light border-2 shadow-md" : ""
                }`}
              >
                {/* Most Popular Badge */}
                {item.mostPopular && (
                  <div className="absolute top-0 right-0 z-10 bg-lh-light text-lh-shadow text-xs px-4 py-1.5 rounded-bl-[18px] rounded-tr-[16px] font-heading tracking-widest uppercase font-bold">
                    Most Popular
                  </div>
                )}

                {/* Image Header with Overlay */}
                <div className="relative h-64 w-full shrink-0 bg-lh-primary-soft">
                  {item.image && (
                    <SanityImage
                      image={item.image}
                      fill
                      className="object-cover"
                    />
                  )}
                  <div className="absolute inset-0 bg-black/40" />
                  <div className="absolute inset-0 p-8 flex flex-col justify-end text-lh-white">
                    <h3 className="text-3xl font-heading mb-2">{item.heading}</h3>
                    <p className="text-sm font-heading tracking-widest uppercase mb-2">{item.subHeading}</p>
                    <div className="text-sm font-bold opacity-90">
                      {item.location}
                    </div>
                  </div>
                </div>

                {/* Content Below Image */}
                <div className="flex flex-col flex-grow p-8">
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
              </article>
            ) : (
              <article
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
              </article>
            )
          ))}
        </div>
      </div>
    </section>
  );
}
