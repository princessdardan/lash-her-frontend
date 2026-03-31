import { defineField, defineType } from "sanity";

export const contact = defineType({
  name: "contact",
  title: "Contact",
  type: "object",
  fields: [
    defineField({
      name: "phone",
      title: "Phone",
      type: "string",
    }),
    defineField({
      name: "email",
      title: "Email",
      type: "string",
    }),
    defineField({
      name: "location",
      title: "Location",
      type: "string",
    }),
  ],
  preview: {
    select: {
      title: "email",
      subtitle: "phone",
    },
  },
});
