import type { ReactElement } from "react";
import type { TCommerceDetailSection } from "@/types";

interface ProductDetailSectionsProps {
  sections: TCommerceDetailSection[];
}

export function ProductDetailSections({ sections }: ProductDetailSectionsProps): ReactElement | null {
  if (!sections || sections.length === 0) {
    return null;
  }

  return (
    <div className="space-y-12">
      {sections.map((section, idx) => (
        <section key={section._key || idx}>
          <div className="flex items-center justify-between py-2 border-b border-lh-line/30 mb-6">
            <h2 className="font-heading text-3xl text-lh-shadow">{section.heading}</h2>
          </div>
          <div className="text-black font-light text-lg">
            {section.content ? (
              <p className="leading-relaxed">{section.content}</p>
            ) : null}
          </div>
        </section>
      ))}
    </div>
  );
}
