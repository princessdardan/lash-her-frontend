import { PortableText, type PortableTextComponents } from "@portabletext/react";
import type { TPortableTextBlock, TTrainingProgram } from "@/types";

const detailItemDescriptionComponents: PortableTextComponents = {
  block: {
    normal: ({ children }) => <p>{children}</p>,
  },
  marks: {
    strong: ({ children }) => <strong>{children}</strong>,
    em: ({ children }) => <em>{children}</em>,
  },
  list: {
    bullet: ({ children }) => (
      <ul className="list-disc list-outside pl-5 space-y-1">{children}</ul>
    ),
    number: ({ children }) => (
      <ol className="list-decimal list-outside pl-5 space-y-1">{children}</ol>
    ),
  },
};

function hasDescription(
  description: string | TPortableTextBlock[] | undefined,
): description is string | TPortableTextBlock[] {
  if (typeof description === "string") return description.trim().length > 0;
  return (
    Array.isArray(description) &&
    description.some((block) =>
      block.children?.some((child) => child.text.trim().length > 0),
    )
  );
}

function DetailItemDescription({
  description,
}: {
  readonly description: string | TPortableTextBlock[];
}) {
  if (typeof description === "string") {
    return (
      <p className="mt-4 font-body text-sm font-bold leading-7 text-lh-shadow/75 md:text-base">
        {description}
      </p>
    );
  }

  return (
    <div className="mt-4 font-body text-sm font-bold leading-7 text-lh-shadow/75 md:text-base">
      <PortableText
        value={description}
        components={detailItemDescriptionComponents}
      />
    </div>
  );
}

interface TrainingEditorialDetailsProps {
  readonly data: TTrainingProgram;
}

export function TrainingEditorialDetails({
  data,
}: TrainingEditorialDetailsProps) {
  const {
    detailEyebrow,
    detailHeading,
    detailDescription,
    detailItems,
    factList,
  } = data;

  const validDetailItems =
    detailItems?.filter(
      (item) => item.title || hasDescription(item.description),
    ) ?? [];
  const facts = factList?.filter(Boolean) ?? [];
  const hasStructuredDetails =
    detailEyebrow ||
    detailHeading ||
    detailDescription ||
    validDetailItems.length > 0 ||
    facts.length > 0;

  if (!hasStructuredDetails) return null;

  return (
    <section
      className="py-10 md:py-12 lg:py-14"
      data-training-editorial-details="true"
    >
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:items-start xl:gap-14">
        <div className="lg:sticky lg:top-32">
          <p className="eyebrow-label mb-4">{detailEyebrow || "Curriculum"}</p>
          {detailHeading && (
            <h2 className="section-heading text-balance">{detailHeading}</h2>
          )}
          {detailDescription && (
            <p className="mt-6 max-w-2xl font-body text-base font-bold leading-8 text-lh-shadow/78 md:text-lg">
              {detailDescription}
            </p>
          )}

          {facts.length > 0 && (
            <aside className="soft-panel mt-8 bg-lh-neutral-2/70 p-6 md:p-7">
              <p className="mb-5 font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-primary">
                Program Facts
              </p>
              <ul className="fact-list grid grid-cols-1 gap-4">
                {facts.map((fact) => (
                  <li key={fact} className="flex items-start gap-3">
                    <span
                      className="mt-3 h-px w-8 shrink-0 bg-lh-light"
                      aria-hidden="true"
                    />
                    <span className="font-body text-base font-bold leading-7 text-lh-shadow/85">
                      {fact}
                    </span>
                  </li>
                ))}
              </ul>
            </aside>
          )}
        </div>

        <div className="space-y-6">
          {validDetailItems.length > 0 && (
            <div
              className="grid grid-cols-1 gap-4"
              data-training-detail-items="true"
            >
              {validDetailItems.map((item, index) => (
                <article
                  key={item._key || `${item.title}-${index}`}
                  className="editorial-card min-h-56 p-6 md:p-7"
                >
                  <span className="mb-4 font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-primary">
                    {item.eyelash || `Lesson ${index + 1}`}
                  </span>
                  {item.title && (
                    <h3 className="font-heading text-3xl font-normal leading-none text-lh-shadow">
                      {item.title}
                    </h3>
                  )}
                  {hasDescription(item.description) && (
                    <DetailItemDescription description={item.description} />
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
