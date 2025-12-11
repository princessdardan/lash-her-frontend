import { BlockRenderer } from "@/components/ui/block-renderer";
import { BlocksContent } from "@/types";

export interface IInfoSectionProps {
    id: number;
    documentId: string;
    __component: string;
    heading: string;
    subHeading: string;
    info: BlocksContent;
}

export function InfoSection({ data }: { data: IInfoSectionProps }) {
    if (!data) return null;

    const { heading, subHeading, info } = data;
    
    return (
        <section className="section-container-pink">
            <div className="content-container">
                <div className="text-container">
                    <h2 className="section-heading-red ">{heading}</h2>
                    <p className="section-subheading">{subHeading}</p>
                </div>
                <div className="section-richtext">
                    <BlockRenderer content={info} />
                </div>
            </div>
        </section>
    );
}