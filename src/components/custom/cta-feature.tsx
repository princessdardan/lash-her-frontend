import { AwardIcon, UsersIcon, VideoIcon } from "lucide-react";
import type { TCtaFeature } from "@/types";

function getIcon(name: string) {
  switch (name) {
    case "CAMERA_ICON":
      return <VideoIcon className="w-12 h-12 mb-4 text-gray-900" />;
    case "USERS_ICON":
      return <UsersIcon className="w-12 h-12 mb-4 text-gray-900" />;
    case "AWARD_ICON":
      return <AwardIcon className="w-12 h-12 mb-4 text-gray-900" />;
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
    <div className="rounded-lg border p-6">
      <div>{getIcon(icon)}</div>
      <h3 className="text-3xl font-bold font-heading">{heading}</h3>
      <p className="text-gray-600">{subHeading}</p>

      {/* Portable Text renderer — Phase 3 */}
      <div className="mt-4">
        {features?.map((block) => (
          <p key={block._key}>
            {block.children?.map((child) => child.text).join("")}
          </p>
        ))}
      </div>

      <div className="mt-4">
        <span className="text-sm text-gray-500">
          {tier} • {location}
        </span>
      </div>
    </div>
  );
}
