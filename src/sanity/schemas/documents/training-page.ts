import { defineField, defineType } from "sanity";

export const trainingPage = defineType({
  name: "trainingPage",
  title: "Training",
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
      type: "string",
    }),
    defineField({
      name: "blocks",
      title: "Blocks",
      type: "array",
      of: [{ type: "ctaFeaturesSection" }, { type: "imageWithText" }],
    }),
  ],
  preview: {
    select: {
      title: "title",
    },
  },
});
