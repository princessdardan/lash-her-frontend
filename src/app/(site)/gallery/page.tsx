import type { Metadata } from "next";
import { Gallery, IGalleryProps } from "@/components/custom/layouts/gallery";
import { HeroSection, IHeroSectionProps } from "@/components/custom/layouts/hero-section";
import { loaders } from "@/data/loaders";
import { validateApiResponse } from "@/lib/error-handler";

export const metadata: Metadata = {
  title: "Gallery | Lash Her",
  description: "Explore our stunning gallery of lash artistry work. View before and after transformations and bespoke lash designs by Nataliea.",
};

export type TGalleryPageBlocks = IHeroSectionProps | IGalleryProps;

function blockRenderer(block: TGalleryPageBlocks, index: number) {
    switch (block.__component) {
        case "layout.hero-section":
            return (<HeroSection key={index} data={block as IHeroSectionProps} />);
        case "layout.photo-gallery":
            return (<Gallery key={index} data={block as IGalleryProps} />);
        default:
            return null;
    }
}
export default async function GalleryPage() {
    const galleryPageData = await loaders.getGalleryPageData();
    const data = validateApiResponse(galleryPageData);
    const { blocks } = data;
    return (
        <main className="mt-28 md:mt-38">
            {blocks.map((block, index) => blockRenderer(block, index))}
        </main>
    );
}