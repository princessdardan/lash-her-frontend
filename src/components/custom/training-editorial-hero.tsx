import type { TTrainingProgram } from "@/types";
import { SanityImage } from "@/components/ui/sanity-image";
import { cn } from "@/lib/utils";

interface TrainingEditorialHeroProps {
  data: TTrainingProgram;
  hasPurchaseUi?: boolean;
}

function getHeroImage(data: TTrainingProgram) {
  return data.detailHeroImage ?? data.detailItems?.find((item) => item.image)?.image ?? data.seo?.image;
}

export function TrainingEditorialHero({ data, hasPurchaseUi = false }: TrainingEditorialHeroProps) {
  const heroImage = getHeroImage(data);
  const heading = data.detailHeading || data.title;
  const description = data.detailDescription || data.description;

  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-[28px] border border-lh-line bg-lh-shadow text-lh-neutral-2 shadow-[0_24px_70px_rgba(28,19,24,0.12)]",
        hasPurchaseUi ? "min-h-[520px] lg:min-h-[620px]" : "min-h-[560px] lg:min-h-[680px]",
      )}
      data-training-detail-hero="true"
    >
      <div className="absolute inset-0 z-0">
        {heroImage ? (
          <SanityImage
            image={heroImage}
            alt={heroImage.alt || heading}
            fill
            priority
            sizes="(min-width: 1024px) 70vw, 100vw"
            className="object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_74%_22%,rgba(212,180,131,0.28),transparent_30%),linear-gradient(135deg,rgba(28,19,24,0.98),rgba(61,11,22,0.92)_48%,rgba(102,57,118,0.88))]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-br from-lh-shadow/35 via-lh-accent/45 to-lh-primary/50 mix-blend-multiply" />
        <div className="absolute inset-0 bg-gradient-to-t from-lh-shadow via-lh-shadow/75 to-lh-shadow/10" />
      </div>

      <div className="relative z-10 flex min-h-[inherit] items-end p-6 sm:p-8 lg:p-12">
        <div className="max-w-4xl">
          <p className="eyebrow-label mb-5 text-lh-light">Training Program</p>
          <h1 className="display-heading text-lh-neutral-2 text-balance">
            {heading}
          </h1>

          {description && (
            <p className="mt-6 max-w-3xl font-body text-base font-bold leading-8 text-lh-neutral-2/85 md:text-lg lg:text-xl">
              {description}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
