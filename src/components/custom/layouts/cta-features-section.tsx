
import { BlockRenderer } from "@/components/ui/block-renderer";
import { BlocksContent, TLink } from "@/types";
import { AwardIcon, UsersIcon, VideoIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export interface CtaFeature {
  id: number;
  __component: string;
  heading: string;
  subHeading: string;
  features: BlocksContent; // ← This is the rich text blocks field
  tier: string;
  location: string;
  icon: string;
  mostPopular: boolean;
  link: TLink;
}

export interface CtaFeaturesSectionProps {
  id: number;
  documentId: string;
  __component: string;
  heading: string;
  subHeading: string;
  description: string;
  features: CtaFeature[];
}

function getIcon(name: string) {
  switch (name) {
    case "VIDEO_ICON":
      return <VideoIcon className="w-4 h-4 text-white" />;
    case "USERS_ICON":
      return <UsersIcon className="w-4 h-4 text-white" />;
    case "AWARD_ICON":
      return <AwardIcon className="w-4 h-4 text-white" />;
    default:
      return null;
  }
}

export async function CtaFeaturesSection({data}: { data: CtaFeaturesSectionProps }) {
  if (!data) return null;
  return (
    <section className= "section-container-pink">
      <div className="content-container">
        {/* Section Header */}
        <div className="text-container">
          <h2 className="section-heading-red ">{data.heading}</h2>
          <p className="section-subheading-white">{data.subHeading}</p>
          {data.description && (
            <p className="section-description">{data.description}</p>
          )}
        </div>

        {/* Features Grid */}
        <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-3 max-w-6xl mx-auto">
          {data.features.map((item: CtaFeature) => (
            <div
              key={item.id}
              className={`rounded-lg border bg-white text-black border-brand-red my-4 p-6 shadow-sm transition-shadow hover:shadow-md relative flex flex-col ${
                item.mostPopular ? "border-brand-red border-2" : ""
              }`}
            >
              {/* Most Popular Badge */}
              {item.mostPopular && (
                <div className="absolute top-0 right-0 bg-brand-red text-white text-xs px-3 py-1 rounded-bl-md rounded-tr-md">
                  Most Popular
                </div>
              )}
              
              {/* Feature Header */}
              <div className="my-4">
                <div className="flex items-start mb-4">
                  <div className={`rounded-full bg-brand-red/80 p-2 inline-flex items-center justify-center ${
                    item.mostPopular ? "bg-brand-red" : ""
                  }`}>
                    {getIcon(item.icon)}
                  </div>
                </div>
                <h3 className="text-2xl font-bold font-serif">{item.heading}</h3>
                <p className="text-sm text-brand-red font-extrabold">{item.subHeading}</p>
                <div className="text-sm font-medium py-1 mb-2 text-black">
                  {item.location}
                </div>
              </div>
              <div className="text-sm text-brand-red font-extrabold">{item.tier}</div>
              {/* Rich Text Content - This is the blocks field */}
              <div className="flex my-4 font-medium">
                <BlockRenderer content={item.features} />
              </div>
              
              {/* CTA Link */}
              {item.link && (
                <Link
                  href={item.link.href}
                  target={item.link.isExternal ? "_blank" : undefined}
                  rel={
                    item.link.isExternal ? "noopener noreferrer" : undefined
                  }
                  className="mt-auto mb-2"
                >
                  <Button className={`w-full text-white font-extrabold border border-brand-dark-grey ${item.mostPopular ? "bg-brand-red hover:bg-brand-red/80" : "bg-brand-red/80 hover:bg-brand-red/60"}`}>
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
