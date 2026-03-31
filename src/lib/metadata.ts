import type { Metadata } from "next";

interface IPageMetadataOptions {
  title: string;
  description: string;
  absolute?: boolean;
}

export function buildPageMetadata({
  title,
  description,
  absolute,
}: IPageMetadataOptions): Metadata {
  return {
    title: absolute ? { absolute: title } : title,
    description,
    openGraph: { title, description },
    twitter: { title, description },
  };
}
