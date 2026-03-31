import { defineField, defineType } from "sanity";

export const homePage = defineType({
  name: "homePage",
  title: "Home Page",
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
      name: "blocks",
      title: "Blocks",
      type: "array",
      of: [{ type: "heroSection" }, { type: "featuresSection" }],
    }),
  ],
  preview: {
    select: {
      title: "title",
    },
  },
});
