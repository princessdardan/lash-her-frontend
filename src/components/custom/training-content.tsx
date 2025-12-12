import {
  CtaFeaturesSection,
  type CtaFeaturesSectionProps,
} from "@/components/custom/layouts/cta-features-section";
import { IImageWithTextProps, ImageWithText } from "@/components/custom/layouts/image-with-text";

export type TTrainingPageBlocks = CtaFeaturesSectionProps | IImageWithTextProps;

interface TrainingContentProps {
  blocks: TTrainingPageBlocks[];
}

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

export function TrainingContent({ blocks }: TrainingContentProps) {
    return (
        <>
            {blocks.map((block, index) => blockRenderer(block, index))}
        </>
    );
}
