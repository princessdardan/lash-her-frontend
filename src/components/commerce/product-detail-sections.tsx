import type { ReactElement } from "react";
import { PortableTextRenderer } from "@/components/ui/portable-text-renderer";
import type { TCommerceDetailSection } from "@/types";

interface ProductDetailSectionsProps {
  readonly sections: TCommerceDetailSection[];
}

function PlainContent({ content }: { readonly content: string }): ReactElement {
  const paragraphs = content.split("\n").map((paragraph) => paragraph.trim()).filter(Boolean);

  return (
    <div className="space-y-4">
      {paragraphs.map((paragraph) => (
        <p key={paragraph} className="font-body text-base font-bold leading-8 text-lh-shadow/78 md:text-lg">
          {paragraph}
        </p>
      ))}
    </div>
  );
}

export function ProductDetailSections({ sections }: ProductDetailSectionsProps): ReactElement | null {
  if (!sections || sections.length === 0) {
    return null;
  }

  const renderableSections = sections.filter((section) => section.heading || section.content || (section.body && section.body.length > 0));

  if (renderableSections.length === 0) {
    return null;
  }

  return (
    <section className="space-y-6" aria-label="Product details">
      {renderableSections.map((section, index) => (
        <section key={section._key || index} className="editorial-card p-6 md:p-8">
          <div className="mb-6 flex items-center gap-4 border-b border-lh-line pb-5">
            <span className="font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-primary">
              {String(index + 1).padStart(2, "0")}
            </span>
            {section.heading && (
              <h2 className="section-subheading text-3xl md:text-4xl">
                {section.heading}
              </h2>
            )}
          </div>
          <div className="max-w-3xl text-lh-shadow/80 [&_li]:font-body [&_li]:font-bold [&_li]:leading-7 [&_ol]:font-body [&_p]:text-lh-shadow/78 [&_ul]:font-body">
            {section.body && section.body.length > 0 ? (
              <PortableTextRenderer content={section.body} />
            ) : section.content ? (
              <PlainContent content={section.content} />
            ) : null}
          </div>
        </section>
      ))}
    </section>
  );
}
