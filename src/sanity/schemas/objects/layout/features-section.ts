import { defineField, defineType } from "sanity";

export const featuresSection = defineType({
  name: "featuresSection",
  title: "Features Section",
  type: "object",
  fields: [
    defineField({
      name: "title",
      title: "Title",
      type: "string",
    }),
    defineField({
      name: "heading",
      title: "Heading",
      type: "string",
    }),
    defineField({
      name: "subHeading",
      title: "Sub Heading",
      type: "string",
    }),
    defineField({
      name: "description",
      title: "Description",
      type: "text",
    }),
    defineField({
      name: "features",
      title: "Features",
      type: "array",
      of: [{ type: "feature" }],
    }),
  ],
  preview: {
    select: {
      title: "heading",
    },
  },
});
