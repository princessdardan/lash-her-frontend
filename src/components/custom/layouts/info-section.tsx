import type { TInfoSection } from "@/types";
import { PortableTextRenderer } from "@/components/ui/portable-text-renderer";

export type { TInfoSection as IInfoSectionProps } from "@/types";

export function InfoSection({ data }: { data: TInfoSection }) {
    if (!data) return null;

    const { heading, subHeading, info } = data;

    return (
        <section className="section-shell">
            <div className="content-container max-w-3xl mx-auto">
                <div className="text-center mb-12">
                    <h2 className="section-heading">{heading}</h2>
                    {subHeading && <p className="font-heading text-lh-primary text-xl md:text-2xl mt-4">{subHeading}</p>}
                    <div className="w-12 h-[1px] bg-lh-light mx-auto mt-6" />
                </div>
                <div className="prose prose-neutral prose-lg max-w-none text-lh-shadow/80 leading-relaxed font-body">
                    <PortableTextRenderer content={info} />
                </div>
            </div>
        </section>
    );
}
