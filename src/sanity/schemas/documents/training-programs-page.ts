import { defineField, defineType } from "sanity";

export const trainingProgramsPage = defineType({
  name: "trainingProgramsPage",
  title: "Training Programs Overview",
  type: "document",
  fields: [
    defineField({
      name: "title",
      title: "Title",
      type: "string",
    }),
    defineField({
      name: "description",
      title: "Description",
      type: "text",
    }),
    defineField({
      name: "trainingPrograms",
      title: "Training Programs",
      type: "array",
      of: [{ type: "reference", to: [{ type: "trainingProgram" }] }],
    }),
  ],
  preview: {
    select: {
      title: "title",
    },
  },
});
