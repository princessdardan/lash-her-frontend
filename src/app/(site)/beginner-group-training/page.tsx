import type { Metadata } from "next";
import { loaders } from "@/data/loaders";
import { validateApiResponse } from "@/lib/error-handler";
import { HeroSection, IHeroSectionProps } from "@/components/custom/layouts/hero-section";
import { IInfoSectionProps, InfoSection } from "@/components/custom/layouts/info-section";
import { ContactFormLabels, IContactFormLabelsProps} from "@/components/custom/collection/contact-components";

// Revalidate every 30 minutes (1800 seconds)
export const revalidate = 1800;

export const metadata: Metadata = {
  title: "Beginner Group Training | Lash Her",
  description: "Start your lash journey with our beginner group training. Learn the fundamentals in a supportive group environment.",
};

export type TrainingProgramBlocks = IHeroSectionProps | IInfoSectionProps | IContactFormLabelsProps;

function blockRenderer(block: TrainingProgramBlocks, index: number)  {
    switch (block.__component) {
        case "layout.hero-section":
            return (<HeroSection key={index} data={block as IHeroSectionProps} />);
        case "layout.info-section":
            return (<InfoSection key={index} data={block as IInfoSectionProps} />);
        case "layout.contact-form":
            return (<ContactFormLabels key={index} data={block as IContactFormLabelsProps} />);
        default:
            return null;
    }
}

export default async function BeginnerGroupTrainingPage() {
    const LDAPageData = await loaders.getTrainingProgramData("beginner-group-training");
    const data = validateApiResponse(LDAPageData, "Beginner Group Training page");
    const { blocks } = data;

    return (
        <main>
            {blocks.map((block, index) => blockRenderer(block, index))}
        </main>
    )
}
