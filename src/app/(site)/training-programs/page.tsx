import type { ReactElement } from "react";
import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { TrainingProgramsSection } from "@/components/custom/training-programs-section";
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

  return <TrainingProgramsSection data={data} />;
}
