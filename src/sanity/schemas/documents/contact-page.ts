import { defineField, defineType } from "sanity";

export const contactPage = defineType({
  name: "contactPage",
  title: "Contact Page",
  type: "document",
  fields: [
    defineField({
      name: "title",
      title: "Title",
      type: "string",
    }),
    defineField({
      name: "subTitle",
      title: "Sub Title",
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
