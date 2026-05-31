import { defineArrayMember, defineField, defineType } from "sanity";

export const homePage = defineType({
  name: "homePage",
  title: "Home Page",
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
      type: "text",
      group: "overview",
    }),
    defineField({
      name: "blocks",
      title: "Blocks",
      type: "array",
      group: "content",
      of: [
        defineArrayMember({ type: "heroSection" }),
        defineArrayMember({ type: "featureSection" }),
        defineArrayMember({ type: "homeTrainingProgramsSection" }),
      ],
    }),
  ],
  preview: {
    select: {
      title: "title",
    },
  },
});
