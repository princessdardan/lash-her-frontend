import type { ReactElement } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { buildPageMetadata } from "@/lib/metadata";

export const revalidate = 1800;

export const metadata = buildPageMetadata({
  title: "Training Programs",
  description:
    "Explore Lash Her by Nataliea's professional lash training programs for beginner and advanced artists.",
});

export default async function TrainingProgramsPage(): Promise<ReactElement> {
  const data = await loaders.getTrainingProgramsPageData();
  if (!data) notFound();

  return (
    <div className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24">
      <div className="content-container">
        <div className="text-container max-w-3xl mx-auto mb-16 text-center">
          <p className="section-eyebrow-red mb-4">Lash Education</p>
          <h1 className="section-heading-red-center text-4xl md:text-5xl lg:text-6xl mb-6">
            {data.title}
          </h1>
          {data.description && (
            <p className="section-description text-lg">{data.description}</p>
          )}
        </div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {data.trainingPrograms.map((program) => (
            <article
              key={program._id}
              className="card-white group flex h-full flex-col p-8 transition-transform duration-300 hover:-translate-y-1"
            >
              <div className="mb-8">
                <p className="mb-3 text-xs font-bold uppercase tracking-[0.22em] text-lh-primary">
                  Training Program
                </p>
                <h2 className="card-heading-red mb-4 text-2xl">
                  {program.title}
                </h2>
                <p className="text-lh-muted leading-7">
                  {program.description}
                </p>
              </div>

              {program.factList && program.factList.length > 0 && (
                <ul className="mb-8 space-y-3 text-sm text-lh-shadow">
                  {program.factList.slice(0, 3).map((fact) => (
                    <li key={fact} className="flex gap-3">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-lh-primary" />
                      <span>{fact}</span>
                    </li>
                  ))}
                </ul>
              )}

              <Link
                href={`/training-programs/${program.slug}`}
                className="mt-auto inline-flex items-center justify-center rounded-full bg-lh-shadow px-6 py-3 text-sm font-bold uppercase tracking-[0.18em] text-lh-neutral-2 transition-colors hover:bg-lh-primary"
              >
                View Details
              </Link>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
