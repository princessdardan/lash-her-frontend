import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { BlockRenderer } from "@/components/custom/layouts/block-renderer";
import { ContactContent } from "@/components/custom/contact-content";
import { TrainingProgramsSection } from "@/components/custom/training-programs-section";
import { buildPageMetadata } from "@/lib/metadata";
import type { THeroSection, TLayoutBlock, TLink } from "@/types";

// Revalidate every 30 minutes (1800 seconds)
export const revalidate = 1800;

export const metadata = buildPageMetadata({
  title: "Lash Her by Nataliea | Lash Artistry & Training",
  description:
    "Elevating beauty through bespoke lash artistry and professional lash training programs. Book your appointment or enroll in training today.",
  absolute: true,
});

function replaceLegacyTrainingHref(href: string): string {
  return href === "/training" ? "/training-programs" : href;
}

function normalizeLinks(links: TLink[] | undefined): TLink[] | undefined {
  return links?.map((link) => ({
    ...link,
    href: replaceLegacyTrainingHref(link.href),
  }));
}

function normalizeHeroLinks(block: THeroSection): THeroSection {
  return {
    ...block,
    link: normalizeLinks(block.link) ?? block.link,
    slides: block.slides?.map((slide) => ({
      ...slide,
      link: normalizeLinks(slide.link),
    })),
  };
}

function normalizeHomeBlocks(blocks: TLayoutBlock[]): TLayoutBlock[] {
  return blocks.map((block) => (block._type === "heroSection" ? normalizeHeroLinks(block) : block));
}

export default async function Home() {
  // Fetch all data in parallel to avoid sequential waterfall
  const [homeData, trainingProgramsData, contactData] = await Promise.all([
    loaders.getHomePageData(),
    loaders.getTrainingProgramsPageData(),
    loaders.getContactPageData(),
  ]);

  if (!homeData) notFound();

  return (
    <>
      <BlockRenderer blocks={normalizeHomeBlocks(homeData.blocks)} />
      {trainingProgramsData && (
        <TrainingProgramsSection data={trainingProgramsData} headingLevel="h2" />
      )}
      {contactData && (
        <ContactContent
          blocks={contactData.blocks}
          pageData={{
            title: contactData.title,
            subTitle: contactData.subTitle,
            description: contactData.description,
          }}
        />
      )}
    </>
  );
}
