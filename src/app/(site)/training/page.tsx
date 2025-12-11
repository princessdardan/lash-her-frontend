import { loaders }  from "@/data/loaders";
import {
  CtaFeaturesSection,
  type CtaFeaturesSectionProps,
} from "@/components/custom/layouts/cta-features-section";
import { validateApiResponse } from "@/lib/error-handler";
import { IImageWithTextProps, ImageWithText } from "@/components/custom/layouts/image-with-text";

export type TTrainingPageBlocks = CtaFeaturesSectionProps | IImageWithTextProps;

function blockRenderer(block: TTrainingPageBlocks, index: number)  {
    switch (block.__component) {
        case "layout.cta-features-section":
            return (<CtaFeaturesSection key={index} data={block as CtaFeaturesSectionProps} />);
        case "layout.image-with-text":
            return (<ImageWithText key={index} data={block as IImageWithTextProps} />);
        default:
            return null;
    }
}

export default async function TrainingPage() {
    const trainingPageData = await loaders.getTrainingsPageData();
    const data = validateApiResponse(trainingPageData, "training");
    const { blocks } = data;
        
    return (
        <main>{blocks.map((block, index) => blockRenderer(block, index))}</main>
    );
}