import type { ReactElement } from "react";
import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { TrainingProgramsSection } from "@/components/custom/training-programs-section";
import { buildPageMetadata } from "@/lib/metadata";
import { JsonLd, buildTrainingProgramCollectionJsonLd } from "@/lib/structured-data";

export const revalidate = 1800;

export const metadata = buildPageMetadata({
  title: "Training Programs",
  description:
    "Explore Lash Her by Nataliea's professional lash training programs for beginner and advanced artists.",
});

export default async function TrainingProgramsPage(): Promise<ReactElement> {
  const data = await loaders.getTrainingProgramsPageData();
  if (!data) notFound();
  const trainingProgramCollectionJsonLd = buildTrainingProgramCollectionJsonLd(data.trainingPrograms);

  return (
    <>
      {trainingProgramCollectionJsonLd && (
        <JsonLd id="lash-her-training-program-list-json-ld" data={trainingProgramCollectionJsonLd} />
      )}
      <TrainingProgramsSection data={data} />
    </>
  );
}
