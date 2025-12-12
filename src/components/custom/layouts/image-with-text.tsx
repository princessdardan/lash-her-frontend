import { BlocksContent, TImage } from "@/types";
import { BlockRenderer } from "../../ui/block-renderer";
import { StrapiImage } from "../../ui/strapi-image";


export interface IImageWithTextProps {
    id: number;
    documentId: string;
    __component: string;
    heading: string;
    subHeading: string;
    description: string;
    perks: BlocksContent;
    image: TImage;
    orientation: string;
    imageLocation: string;
}


export function ImageWithText({ data }: { data: IImageWithTextProps }) {
    if (!data) return null;
    
    const { heading, subHeading, description, perks, image, orientation } = data;
    
    // Text content component
    const TextContent = () => (
        <div className={`w-full ${orientation === 'VERTICAL' ? 'py-2 text-center flex flex-col items-center' : 'py-8 lg:w-1/2 max-w-xl'}`}>
            <h2 className="text-2xl text-brand-red mb-4 font-heading">{heading}</h2>
            <h3 className="text-lg text-brand-red mb-4 font-heading">{subHeading}</h3>
            <p className="text-black mb-6 max-w-xl">{description}</p>
            <div className={`prose prose-lg text-black ${orientation === 'VERTICAL' ? 'mx-auto text-center' : ''}`}>
                <BlockRenderer content={perks} />
            </div>
        </div>
    );
        
    // Image content component
    const ImageContent = () => (
        <div className={`w-full ${orientation === 'VERTICAL' ? 'py-2 flex justify-center' : 'py-6 lg:w-1/2'}`}>
            <StrapiImage
                src={image.url}
                alt={image.alternativeText || heading || "Section image"}
                className={`object-cover rounded-lg shadow-lg ${
                    orientation === 'VERTICAL' ? 'w-full aspect-square max-w-md' : 'w-full h-auto max-h-96'
                }`}
                height={orientation === 'VERTICAL' ? 400 : 384}
                width={orientation === 'VERTICAL' ? 400 : 400}
            />
        </div>
    );
    
    // Determine layout based on orientation
    const renderLayout = () => {
        switch (orientation) {
            case 'HORIZONTAL_IMAGE_LEFT':
                // Image on left, text on right
                return (
                    <div className="flex flex-col lg:flex-row items-center gap-8">
                        <ImageContent />
                        <TextContent />
                    </div>
                );
            case 'HORIZONTAL_IMAGE_RIGHT':
                // Text on left, image on right (default)
                return (
                    <div className="flex flex-col lg:flex-row items-center gap-8">
                        <TextContent />
                        <ImageContent />
                    </div>
                );
            case 'VERTICAL':
                // Image on top, text on bottom
                return (
                    <div className="flex flex-col items-center gap-4">
                        <ImageContent />
                        <TextContent />
                    </div>
                );
            default:
                // Default to HORIZONTAL_IMAGE_RIGHT
                return (
                    <div className="flex flex-col lg:flex-row items-center gap-8">
                        <TextContent />
                        <ImageContent />
                    </div>
                );
        }
    };
    
    return (
        <section className="px-8 pb-6 mx-auto md:px-6 lg:py-2 bg-brand-pink">
            <div className={`mx-auto ${orientation === 'VERTICAL' ? 'max-w-2xl' : 'container max-w-6xl'}`}>
                <div className="rounded-lg border bg-white text-black border-brand-red my-4 py-6 px-10 shadow-sm transition-shadow hover:shadow-md">
                    {renderLayout()}
                </div>
            </div>
        </section>
    )
}