import { defineField, defineType } from "sanity";

export const menuLink = defineType({
  name: "menuLink",
  title: "Menu Link",
  type: "object",
  fields: [
    defineField({
      name: "name",
      title: "Name",
      type: "string",
    }),
    defineField({
      name: "url",
      title: "URL",
      type: "string",
    }),
  ],
  preview: {
    select: {
      title: "name",
      subtitle: "url",
    },
  },
});
