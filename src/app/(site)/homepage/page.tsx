import { loaders } from "@/data/loaders";
import { validateApiResponse } from "@/lib/error-handler";

import {
  HeroSection,
  type IHeroSectionProps,
} from "@/components/custom/layouts/hero-section";

// Revalidate every 30 minutes (1800 seconds)
export const revalidate = 1800;
import {
  FeaturesSection,
  type IFeaturesSectionProps,
} from "@/components/custom/layouts/features-section";
import { TrainingContent } from "@/components/custom/training-content";
import { ContactContent } from "@/components/custom/contact-content";

// Union type of all possible block components
export type TBlocks = IHeroSectionProps | IFeaturesSectionProps ;

function blockRenderer(block: TBlocks, index: number) {
  switch (block.__component) {
    case "layout.hero-section":
      return <HeroSection key={index} data={block as IHeroSectionProps} />;
    case "layout.features-section":
      console.log("Sections data:", block);
      return (
        <FeaturesSection key={index} data={block as IFeaturesSectionProps} />
      );
    default:
      return null;
  }
}

export default async function Home() {
  // Fetch all data in parallel to avoid sequential waterfall
  const [homePageData, trainingPageData, contactPageData] = await Promise.all([
    loaders.getHomePageData(),
    loaders.getTrainingsPageData(),
    loaders.getContactPageData(),
  ]);
  
  const homeData = validateApiResponse(homePageData, "home page");
  const trainingData = validateApiResponse(trainingPageData, "training");
  const contactData = validateApiResponse(contactPageData, "contact page");

  return (
    <main>
      {homeData.blocks.map((block, index) => blockRenderer(block, index))}
      <TrainingContent blocks={trainingData.blocks} />
      <ContactContent blocks={contactData.blocks} pageData={{
        id: contactData.id,
        documentId: contactData.documentId,
        title: contactData.title,
        subTitle: contactData.subTitle,
        description: contactData.description,
      }} />
    </main>
  );
}