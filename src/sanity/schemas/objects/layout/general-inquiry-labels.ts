import { defineField, defineType } from "sanity";

export const generalInquiryLabels = defineType({
  name: "generalInquiryLabels",
  title: "General Inquiry Labels",
  type: "object",
  fields: [
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
      name: "name",
      title: "Name Label",
      type: "string",
    }),
    defineField({
      name: "email",
      title: "Email Label",
      type: "string",
    }),
    defineField({
      name: "phone",
      title: "Phone Label",
      type: "string",
    }),
    defineField({
      name: "instagram",
      title: "Instagram Label",
      type: "string",
    }),
    defineField({
      name: "message",
      title: "Message Label",
      type: "string",
    }),
  ],
  preview: {
    select: {
      title: "heading",
    },
  },
});
