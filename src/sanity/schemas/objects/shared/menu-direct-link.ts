import { defineField, defineType } from "sanity";

export const menuDirectLink = defineType({
  name: "menuDirectLink",
  title: "Menu Direct Link",
  type: "object",
  fields: [
    defineField({
      name: "title",
      title: "Title",
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
      title: "title",
      subtitle: "url",
    },
  },
});
