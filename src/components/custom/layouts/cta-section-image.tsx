import type { TSanityImage, TLink } from "@/types";

export interface CTASectionImageProps {
  _type: "ctaSectionImage";
  _key: string;
  heading: string;
  description: string;
  image: TSanityImage;
  link: TLink[];
}

export function CtaSectionImage({ data }: { data: CTASectionImageProps }) {
  if (!data) return null;
  const { heading, description, image, link } = data;
  return (
    <div>
      {/* CTA Section Image — renders heading, description, image, links */}
    </div>
  );
}
