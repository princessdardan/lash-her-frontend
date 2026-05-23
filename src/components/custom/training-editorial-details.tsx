import type { TTrainingProgram } from "@/types";

interface TrainingEditorialDetailsProps {
  readonly data: TTrainingProgram;
}

export function TrainingEditorialDetails({ data }: TrainingEditorialDetailsProps) {
  const {
    detailEyebrow,
    detailHeading,
    detailDescription,
    detailItems,
    factList,
  } = data;

  const validDetailItems = detailItems?.filter((item) => item.title || item.description) ?? [];
  const facts = factList?.filter(Boolean) ?? [];
  const hasStructuredDetails = detailEyebrow || detailHeading || detailDescription || validDetailItems.length > 0 || facts.length > 0;

  if (!hasStructuredDetails) return null;

  return (
    <section className="py-10 md:py-12 lg:py-14" data-training-editorial-details="true">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:items-start xl:gap-14">
        <div className="lg:sticky lg:top-32">
          <p className="eyebrow-label mb-4">
            {detailEyebrow || "Curriculum"}
          </p>
          {detailHeading && (
            <h2 className="section-heading text-balance">
              {detailHeading}
            </h2>
          )}
          {detailDescription && (
            <p className="mt-6 max-w-2xl font-body text-base font-bold leading-8 text-lh-shadow/78 md:text-lg">
              {detailDescription}
            </p>
          )}

          {facts.length > 0 && (
            <div className="soft-panel mt-8 bg-lh-neutral-2/70 p-6 md:p-7">
              <p className="mb-5 font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-primary">
                Program Facts
              </p>
              <ul className="fact-list grid grid-cols-1 gap-4">
                {facts.map((fact) => (
                  <li key={fact} className="flex items-start gap-3">
                    <span className="mt-3 h-px w-8 shrink-0 bg-lh-light" aria-hidden="true" />
                    <span className="font-body text-base font-bold leading-7 text-lh-shadow/85">{fact}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="space-y-6">
          {validDetailItems.length > 0 && (
            <div className="grid grid-cols-1 gap-4" data-training-detail-items="true">
              {validDetailItems.map((item, index) => (
                <article key={item._key || `${item.title}-${index}`} className="editorial-card min-h-56 p-6 md:p-7">
                  <span className="mb-4 font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-primary">
                    {item.eyelash || `Lesson ${index + 1}`}
                  </span>
                  {item.title && <h3 className="font-heading text-3xl font-normal leading-none text-lh-shadow">{item.title}</h3>}
                  {item.description && (
                    <p className="mt-4 font-body text-sm font-bold leading-7 text-lh-shadow/75 md:text-base">
                      {item.description}
                    </p>
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
