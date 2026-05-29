import { TrainingProgramsSection } from "@/components/custom/training-programs-section";
import type { THomeTrainingProgramsSection } from "@/types";

interface HomeTrainingProgramsSectionProps {
  data: THomeTrainingProgramsSection;
}

export function HomeTrainingProgramsSection({ data }: HomeTrainingProgramsSectionProps) {
  if (!data.trainingProgramsPage) {
    return null;
  }

  return <TrainingProgramsSection data={data.trainingProgramsPage} headingLevel="h2" />;
}
