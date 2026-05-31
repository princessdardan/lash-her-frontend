import { AwardIcon, UsersIcon, VideoIcon } from "lucide-react";
import type { TCtaFeature } from "@/types";
import { PortableTextRenderer } from "@/components/ui/portable-text-renderer";

function getIcon(name: string) {
  switch (name) {
    case "CAMERA_ICON":
      return <VideoIcon className="w-12 h-12 mb-4 text-current" aria-hidden="true" />;
    case "USERS_ICON":
      return <UsersIcon className="w-12 h-12 mb-4 text-current" aria-hidden="true" />;
    case "AWARD_ICON":
      return <AwardIcon className="w-12 h-12 mb-4 text-current" aria-hidden="true" />;
    default:
      return null;
  }
}

export function CtaFeature({
  heading,
  subHeading,
  features,
  tier,
  location,
  icon,
}: TCtaFeature) {
  return (
    <article className="editorial-card relative flex flex-col min-h-[480px] p-8">
      <div className="mb-6">
        <div className="flex items-start mb-6">
          <div className="rounded-full bg-lh-primary-soft p-3 inline-flex items-center justify-center text-lh-primary">
            {getIcon(icon)}
          </div>
        </div>
        <h3 className="text-3xl font-heading text-lh-shadow mb-2">{heading}</h3>
        <p className="text-sm text-lh-primary font-heading tracking-widest uppercase mb-4">{subHeading}</p>
        <div className="w-12 h-[1px] bg-lh-light mb-4" />
        <div className="text-sm font-bold text-lh-shadow/70">
          {location}
        </div>
      </div>
      <div className="text-sm text-lh-primary font-heading tracking-widest uppercase mb-6">{tier}</div>

      {/* Portable Text content */}
      <div className="flex-grow mb-8 text-lh-shadow/80 leading-relaxed">
        <PortableTextRenderer content={features} />
      </div>
    </article>
  );
}
