import { defineField, defineType } from "sanity";

export const contactPage = defineType({
  name: "contactPage",
  title: "Contact Page",
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
      name: "subTitle",
      title: "Sub Title",
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
        { type: "contactInfo" },
        { type: "schedule" },
        { type: "contactFormLabels" },
        { type: "generalInquiryLabels" },
      ],
    }),
  ],
  preview: {
    select: {
      title: "title",
    },
  },
});
