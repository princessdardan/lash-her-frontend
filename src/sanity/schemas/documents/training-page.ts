import { defineField, defineType } from "sanity";

export const trainingPage = defineType({
  name: "trainingPage",
  title: "Training",
  type: "document",
  groups: [
    { name: "overview", title: "Overview" },
    { name: "content", title: "Content" },
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
      type: "string",
      group: "overview",
    }),
    defineField({
      name: "blocks",
      title: "Blocks",
      type: "array",
      group: "content",
      of: [{ type: "ctaFeaturesSection" }, { type: "imageWithText" }],
    }),
  ],
  preview: {
    select: {
      title: "title",
    },
  },
});
