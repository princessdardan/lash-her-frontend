import { defineField, defineType } from "sanity";

export const contactInfo = defineType({
  name: "contactInfo",
  title: "Contact Info",
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
      name: "contact",
      title: "Contact",
      type: "array",
      of: [{ type: "contact" }],
    }),
  ],
  preview: {
    select: {
      title: "heading",
    },
  },
});
