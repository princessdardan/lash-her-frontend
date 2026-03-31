import Image from "next/image";
import imageUrlBuilder from "@sanity/image-url";
import { client } from "@/sanity/lib/client";
import type { TSanityImage } from "@/types";

const builder = imageUrlBuilder(client);

interface ISanityImageProps {
  image: TSanityImage;
  alt?: string;
  width?: number;
  height?: number;
  className?: string;
  fill?: boolean;
  priority?: boolean;
}

export function SanityImage({
  image,
  alt,
  className,
  priority,
  width,
  height,
  fill,
}: ISanityImageProps) {
  if (!image?.asset?._ref) return null;

  const url = builder.image(image).auto("format").fit("max").url();

  return (
    <Image
      src={url}
      alt={alt ?? image.alt ?? ""}
      className={className}
      priority={priority}
      {...(fill ? { fill } : { width: width ?? 800, height: height ?? 600 })}
    />
  );
}
