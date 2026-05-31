import { defineField, defineType } from "sanity";

export const trainingProgramsPage = defineType({
  name: "trainingProgramsPage",
  title: "Training Programs Overview",
  type: "document",
  groups: [
    { name: "overview", title: "Overview" },
    { name: "programs", title: "Programs" },
  ],
  fields: [
    defineField({
      name: "title",
      title: "Title",
      type: "string",
      group: "overview",
    }),
    defineField({
      name: "description",
      title: "Description",
      type: "text",
      group: "overview",
    }),
    defineField({
      name: "trainingPrograms",
      title: "Training Programs",
      type: "array",
      group: "programs",
      of: [{ type: "reference", to: [{ type: "trainingProgram" }] }],
    }),
  ],
  preview: {
    select: {
      title: "title",
    },
  },
});
