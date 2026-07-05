import type { ReactElement } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SanityImage } from "@/components/ui/sanity-image";
import type { TTrainingProgram, TTrainingProgramsPage } from "@/types";

type HeadingLevel = "h1" | "h2";

interface TrainingProgramsSectionProps {
  data: TTrainingProgramsPage;
  headingLevel?: HeadingLevel;
}

function getProgramFacts(program: TTrainingProgram): string[] {
  if (program.factList && program.factList.length > 0) {
    return program.factList;
  }

  return program.detailItems?.map((item) => item.title).filter(Boolean) ?? [];
}

function TrainingProgramCard({
  program,
  index,
}: {
  program: TTrainingProgram;
  index: number;
}): ReactElement {
  const facts = getProgramFacts(program).slice(0, 3);
  const image = program.image ?? program.heroImage ?? program.seo?.image;
  const ctaLabel =
    program.primaryCta?.label ?? program.checkoutCtaLabel ?? "View Details";

  return (
    <article className="editorial-card group min-h-[520px] overflow-hidden p-0 transition-transform duration-300 hover:-translate-y-1">
      <div className="relative min-h-64 w-full shrink-0 overflow-hidden bg-lh-primary-soft">
        {image ? (
          <SanityImage
            image={image}
            fill
            sizes="(min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw"
            className="object-cover transition-transform duration-500 group-hover:scale-105"
            priority={index === 0}
          />
        ) : (
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_20%,rgba(212,180,131,0.34),transparent_28%),linear-gradient(135deg,rgba(28,19,24,0.94),rgba(61,11,22,0.9)_48%,rgba(102,57,118,0.86))]" />
        )}
        <div className="absolute inset-0 bg-lh-shadow/50" />
        <div className="absolute inset-x-0 bottom-0 p-8 text-lh-neutral-2">
          <p className="mb-3 font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-light">
            Training Program
          </p>
          <h3 className="font-heading text-3xl font-normal leading-none text-lh-neutral-2 md:text-4xl">
            {program.title}
          </h3>
        </div>
      </div>

      <div className="flex flex-1 flex-col p-8">
        <div className="mb-5 flex flex-wrap gap-3">
          {program.availabilityLabel && (
            <span className="rounded-full border border-lh-line px-3 py-1 font-body text-xs font-bold uppercase tracking-[0.12em] text-lh-muted">
              {program.availabilityLabel}
            </span>
          )}
          {program.checkoutEnabled && (
            <span className="rounded-full bg-lh-light px-3 py-1 font-body text-xs font-bold uppercase tracking-[0.12em] text-lh-shadow">
              Enrollment Open
            </span>
          )}
        </div>

        <p className="mb-6 text-sm leading-7 text-lh-shadow/80 md:text-base">
          {program.description}
        </p>

        {facts.length > 0 && (
          <ul className="mb-8 space-y-3 text-sm text-lh-shadow/80">
            {facts.map((fact) => (
              <li key={fact} className="flex gap-3">
                <span className="mt-2 h-px w-8 shrink-0 bg-lh-light" />
                <span>{fact}</span>
              </li>
            ))}
          </ul>
        )}

        <Button
          asChild
          variant={program.checkoutEnabled ? "primary" : "outline"}
          className="mt-auto w-full"
        >
          <Link href={`/training-programs/${program.slug}`}>{ctaLabel}</Link>
        </Button>
      </div>
    </article>
  );
}

export function TrainingProgramsSection({
  data,
  headingLevel = "h1",
}: TrainingProgramsSectionProps): ReactElement | null {
  const programs = data.trainingPrograms.filter((program) =>
    Boolean(program.slug),
  );
  const Heading = headingLevel;
  const trainingProgramsGridClassName =
    programs.length === 1
      ? "mx-auto grid grid-cols-1 items-stretch justify-center gap-8 md:grid-cols-[minmax(0,24.5rem)]"
      : programs.length === 2
        ? "mx-auto grid grid-cols-1 items-stretch justify-center gap-8 md:grid-cols-[repeat(2,minmax(0,24.5rem))]"
        : "mx-auto grid max-w-6xl grid-cols-1 items-stretch gap-8 md:grid-cols-2 lg:grid-cols-3";

  if (programs.length === 0) {
    return null;
  }

  return (
    <section
      className="section-shell-soft"
      data-training-programs-section="true"
    >
      <div className="content-container">
        <header className="text-container mx-auto max-w-3xl">
          <p className="eyebrow-label mb-4">Lash Education</p>
          <Heading className="section-heading mb-6">{data.title}</Heading>
          {data.description && (
            <p className="section-description text-lg">{data.description}</p>
          )}
        </header>

        <div className={trainingProgramsGridClassName}>
          {programs.map((program, index) => (
            <TrainingProgramCard
              key={program._id}
              program={program}
              index={index}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
