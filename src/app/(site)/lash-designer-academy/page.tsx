import type { Metadata } from "next";
import { loaders } from "@/data/loaders";
import { validateApiResponse } from "@/lib/error-handler";
import { HeroSection, IHeroSectionProps } from "@/components/custom/layouts/hero-section";
import { IInfoSectionProps, InfoSection } from "@/components/custom/layouts/info-section";
import { ContactFormLabels, IContactFormLabelsProps} from "@/components/custom/collection/contact-components";

export const metadata: Metadata = {
  title: "Lash Designer Academy | Lash Her",
  description: "Professional lash design certification and comprehensive training programs. Become a certified lash designer with expert instruction.",
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

export default async function LashDesignerAcademyPage() {
    const LDAPageData = await loaders.getTrainingProgramData("lash-designer-academy");
    const data = validateApiResponse(LDAPageData, "Lash Designer Academy page");
    const { blocks } = data;

    return (
        <main>
            {blocks.map((block, index) => blockRenderer(block, index))}
        </main>
    )
}
