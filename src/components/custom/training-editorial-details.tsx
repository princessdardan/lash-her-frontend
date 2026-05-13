import { SanityImage } from "@/components/ui/sanity-image";
import { TrainingDetailItems } from "@/components/custom/training-detail-items";
import type { TTrainingProgram } from "@/types";

interface TrainingEditorialDetailsProps {
  data: TTrainingProgram;
}

export function TrainingEditorialDetails({ data }: TrainingEditorialDetailsProps) {
  const {
    detailEyebrow,
    detailHeading,
    detailDescription,
    detailItems,
    factList,
    detailMainImage,
  } = data;

  const hasStructuredDetails = detailHeading || detailDescription || (detailItems && detailItems.length > 0) || (factList && factList.length > 0);

  if (!hasStructuredDetails) return null;

  return (
    <section className="py-24 md:py-32 bg-lh-neutral-2/50" data-structured-details="true">
      <div className="max-w-[1180px] mx-auto px-6 md:px-8">
        <div className="mb-16 md:mb-20">
          {detailEyebrow && (
            <p className="font-sans text-xs font-semibold text-lh-primary mb-4 tracking-[0.2em] uppercase">
              {detailEyebrow}
            </p>
          )}
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

        {detailMainImage ? (
          <div className="grid grid-cols-1 md:grid-cols-12 gap-12 md:gap-16 items-start">
            <div className="md:col-span-5 flex flex-col gap-10">
              {detailItems && detailItems.map((item, index) => (
                <div key={item._key || index} className="group">
                  <h3 className="font-serif text-3xl text-lh-shadow mt-1">{item.title}</h3>
                  <p className="font-sans text-base text-lh-shadow/80 mt-3 leading-relaxed">
                    {item.description}
                  </p>
                </div>
              ))}
              
              {factList && factList.length > 0 && (
                <div className="mt-4 pt-10 border-t border-lh-line">
                  <ul className="space-y-4">
                    {factList.map((fact, index) => (
                      <li key={index} className="flex items-start gap-3">
                        <span className="text-lh-primary mt-1 text-xl leading-none">•</span>
                        <span className="font-sans text-base text-lh-shadow/90">{fact}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            
            <div className="md:col-span-7">
              <div className="relative aspect-[4/5] rounded-[24px] overflow-hidden shadow-2xl border border-lh-line/50">
                <SanityImage
                  image={detailMainImage}
                  alt={detailMainImage.alt || detailHeading || "Training details"}
                  fill
                  className="object-cover"
                />
              </div>
            </div>
          </div>
        ) : (
          <>
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
          </>
        )}
      </div>
    </section>
  );
}
