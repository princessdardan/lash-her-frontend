import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { validateApiResponse } from "@/lib/error-handler";
import { HeroSection, IHeroSectionProps } from "@/components/custom/layouts/hero-section";
import { IInfoSectionProps, InfoSection } from "@/components/custom/layouts/info-section";
import { ContactFormLabels, IContactFormLabelsProps} from "@/components/custom/collection/contact-components";

export const revalidate = 1800;

export type TrainingProgramBlocks = IHeroSectionProps | IInfoSectionProps | IContactFormLabelsProps;

function blockRenderer(block: TrainingProgramBlocks, index: number) {
  switch (block.__component) {
    case "layout.hero-section":
      return <HeroSection key={index} data={block as IHeroSectionProps} />;
    case "layout.info-section":
      return <InfoSection key={index} data={block as IInfoSectionProps} />;
    case "layout.contact-form":
      return <ContactFormLabels key={index} data={block as IContactFormLabelsProps} />;
    default:
      return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const { data } = await loaders.getTrainingProgramBySlug(slug);
  
  return {
    title: data?.title ? `${data.title} | Lash Her` : "Training | Lash Her",
    description: data?.description || "Professional lash training programs",
  };
}

// Optional: Generate static params for known slugs
export async function generateStaticParams() {
  return [
    { slug: "beginner-private-training" },
    { slug: "advanced-private-training" },
    { slug: "lash-designer-academy" },
    { slug: "beginner-group-training" },
  ];
}

export default async function TrainingProgramPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const TrainingProgramPageData = await loaders.getTrainingProgramBySlug(slug);
    const data = validateApiResponse(TrainingProgramPageData, "Training Program page");
  
  if (!data) {
    notFound();
  }

  const {blocks} = data;

  return (
    <main>
      {blocks?.map((block, index) => blockRenderer(block, index))}
    </main>
  );
}