import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { BlockRenderer } from "@/components/custom/layouts/block-renderer";
import { buildPageMetadata } from "@/lib/metadata";

// Revalidate every 30 minutes (1800 seconds)
export const revalidate = 1800;

export const metadata = buildPageMetadata({
  title: "Gallery",
  description:
    "Explore our stunning gallery of lash artistry work. View before and after transformations and bespoke lash designs by Nataliea.",
});

export default async function GalleryPage() {
  const data = await loaders.getGalleryPageData();
  if (!data) notFound();

  return (
    <div className="mt-28 md:mt-38">
      <BlockRenderer blocks={data.blocks} />
    </div>
  );
}
