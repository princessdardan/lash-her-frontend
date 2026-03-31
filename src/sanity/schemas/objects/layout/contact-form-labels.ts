import { defineField, defineType } from "sanity";

export const contactFormLabels = defineType({
  name: "contactFormLabels",
  title: "Contact Form Labels",
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
      name: "location",
      title: "Location Label",
      type: "string",
    }),
    defineField({
      name: "interest",
      title: "Interest Label",
      type: "string",
    }),
    defineField({
      name: "experience",
      title: "Experience Label",
      type: "string",
    }),
    defineField({
      name: "clients",
      title: "Clients Label",
      type: "string",
    }),
    defineField({
      name: "info",
      title: "Info Label",
      type: "string",
    }),
  ],
  preview: {
    select: {
      title: "heading",
    },
  },
});
