import { TrainingDetailItems } from "@/components/custom/training-detail-items";
import type { TTrainingProgram } from "@/types";

interface TrainingEditorialDetailsProps {
  data: TTrainingProgram;
}

export function TrainingEditorialDetails({ data }: TrainingEditorialDetailsProps) {
  const {
    detailHeading,
    detailDescription,
    detailItems,
    factList,
  } = data;

  const hasStructuredDetails = detailHeading || detailDescription || (detailItems && detailItems.length > 0) || (factList && factList.length > 0);

  if (!hasStructuredDetails) return null;

  return (
    <section className="py-24 md:py-32 bg-lh-neutral-2/50" data-structured-details="true">
      <div className="max-w-[1180px] mx-auto px-6 md:px-8">
        <div className="mb-16 md:mb-20">
          {detailHeading && (
            <h2 className="font-serif text-5xl md:text-6xl text-lh-shadow">
              {detailHeading}
            </h2>
          )}
          {detailDescription && (
            <p className="font-sans text-lg text-lh-shadow/80 max-w-2xl mt-6 leading-relaxed">
              {detailDescription}
            </p>
          )}
        </div>

        {detailItems && detailItems.length > 0 && (
          <TrainingDetailItems items={detailItems} />
        )}
        
        {factList && factList.length > 0 && (
          <div className="soft-panel mt-12 p-8 md:p-12 rounded-[24px] bg-lh-neutral/30 border border-lh-line/30">
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {factList.map((fact, index) => (
                <li key={index} className="flex items-start gap-3">
                  <span className="text-lh-primary mt-1 text-xl leading-none">•</span>
                  <span className="font-sans text-lg text-lh-shadow/90">{fact}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
