import type { TInfoSection } from "@/types";
import { PortableTextRenderer } from "@/components/ui/portable-text-renderer";

export type { TInfoSection as IInfoSectionProps } from "@/types";

export function InfoSection({ data }: { data: TInfoSection }) {
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
                    <PortableTextRenderer content={info} />
                </div>
            </div>
        </section>
    );
}
