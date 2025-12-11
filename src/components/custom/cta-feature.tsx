import { AwardIcon, UsersIcon, VideoIcon } from "lucide-react";
import { BlockRenderer } from "../ui/block-renderer";
import { BlocksContent } from "@/types";

// Example: How to type a component that receives Strapi block content
export interface CtaFeatureProps {
  heading: string;
  __component: string;
  subheading: string;
  features: BlocksContent; // This is how you type the Strapi blocks field
  tier: string;
  location: string;
  icon: string;
}

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
  subheading,
  features,
  tier,
  location,
  icon,
}: CtaFeatureProps) {
  return (
    <div className="rounded-lg border p-6">
      <div>{getIcon(icon)}</div>
      <h3 className="text-3xl font-bold font-heading">{heading}</h3>
      <p className="text-gray-600">{subheading}</p>
      
      {/* Render the block content */}
      <div className="mt-4">
        <BlockRenderer content={features} />
      </div>
      
      <div className="mt-4">
        <span className="text-sm text-gray-500">
          {tier} • {location}
        </span>
      </div>
    </div>
  );
}
