import { DocumentIcon } from "@sanity/icons";
import { defineField, defineType } from "sanity";

export const homeTrainingProgramsSection = defineType({
  name: "homeTrainingProgramsSection",
  title: "Training Programs Feature",
  type: "object",
  icon: DocumentIcon,
  fields: [
    defineField({
      name: "trainingProgramsPage",
      title: "Training Programs Overview",
      type: "reference",
      to: [{ type: "trainingProgramsPage" }],
      description: "Select the training programs overview content to feature on the homepage.",
      validation: (Rule) => Rule.required(),
    }),
  ],
  preview: {
    select: {
      title: "trainingProgramsPage.title",
    },
    prepare({ title }) {
      return {
        title: title || "Training Programs Feature",
        subtitle: "Homepage block",
      };
    },
  },
});
