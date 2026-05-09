import type { TImageWithText } from "@/types";
import { SanityImage } from "../../ui/sanity-image";
import { PortableTextRenderer } from "@/components/ui/portable-text-renderer";

export type { TImageWithText as IImageWithTextProps } from "@/types";

export function ImageWithText({ data }: { data: TImageWithText }) {
    if (!data) return null;

    const { heading, subHeading, description, perks, image, orientation } = data;

    // Text content component
    const TextContent = () => (
        <div className={`w-full ${orientation === 'VERTICAL' ? 'py-8 text-center flex flex-col items-center' : 'py-12 lg:py-16 lg:w-1/2 max-w-xl z-10'}`}>
            <div className={`soft-panel p-8 md:p-12 ${orientation === 'HORIZONTAL_IMAGE_LEFT' ? 'lg:-ml-16' : orientation === 'HORIZONTAL_IMAGE_RIGHT' ? 'lg:-mr-16' : ''}`}>
                <h2 className="text-3xl md:text-4xl text-lh-shadow mb-4 font-heading">{heading}</h2>
                <h3 className="text-lg text-lh-primary mb-6 font-heading tracking-widest uppercase">{subHeading}</h3>
                <div className="w-12 h-[1px] bg-lh-light mb-6" />
                <p className="text-lh-shadow/80 mb-8 max-w-xl leading-relaxed">{description}</p>
                <div className={`prose prose-neutral max-w-none text-lh-shadow/80 ${orientation === 'VERTICAL' ? 'mx-auto text-center' : ''}`}>
                    <PortableTextRenderer content={perks} />
                </div>
            </div>
        </div>
    );

    // Image content component
    const ImageContent = () => (
        <div className={`w-full ${orientation === 'VERTICAL' ? 'py-4 flex justify-center' : 'lg:w-1/2'}`}>
            <SanityImage
                image={image}
                alt={image.alt || heading || "Section image"}
                className={`object-cover rounded-[24px] shadow-sm ${
                    orientation === 'VERTICAL' ? 'w-full aspect-square max-w-2xl' : 'w-full h-full min-h-[500px] max-h-[700px]'
                }`}
                height={orientation === 'VERTICAL' ? 800 : 1000}
                width={orientation === 'VERTICAL' ? 800 : 800}
            />
        </div>
    );

    // Determine layout based on orientation
    const renderLayout = () => {
        switch (orientation) {
            case 'HORIZONTAL_IMAGE_LEFT':
                // Image on left, text on right
                return (
                    <div className="flex flex-col lg:flex-row items-center">
                        <ImageContent />
                        <TextContent />
                    </div>
                );
            case 'HORIZONTAL_IMAGE_RIGHT':
                // Text on left, image on right (default)
                return (
                    <div className="flex flex-col-reverse lg:flex-row items-center">
                        <TextContent />
                        <ImageContent />
                    </div>
                );
            case 'VERTICAL':
                // Image on top, text on bottom
                return (
                    <div className="flex flex-col items-center">
                        <ImageContent />
                        <TextContent />
                    </div>
                );
            default:
                // Default to HORIZONTAL_IMAGE_RIGHT
                return (
                    <div className="flex flex-col-reverse lg:flex-row items-center">
                        <TextContent />
                        <ImageContent />
                    </div>
                );
        }
    };

    return (
        <section className="section-shell">
            <div className={`mx-auto ${orientation === 'VERTICAL' ? 'max-w-4xl' : 'container max-w-7xl'}`}>
                {renderLayout()}
            </div>
        </section>
    )
}
