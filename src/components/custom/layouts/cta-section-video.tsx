import type { TSanityImage, TLink } from "@/types";

export interface CTASectionVideoProps {
  _type: "ctaSectionVideo";
  _key: string;
  heading: string;
  description: string;
  image: TSanityImage;
  link: TLink[];
}

export function CtaSectionVideo({ data }: { data: CTASectionVideoProps }) {
  if (!data) return null;
  const { heading, description, image, link } = data;
  return (
    <div>
      {/* CTA Section Video — renders heading, description, video/image, links */}
    </div>
  );
}
