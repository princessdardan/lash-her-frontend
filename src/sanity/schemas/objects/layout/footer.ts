import { defineField, defineType } from "sanity";

export const footer = defineType({
  name: "footer",
  title: "Footer",
  type: "object",
  fields: [
    defineField({
      name: "logoText",
      title: "Logo Text",
      type: "link",
    }),
    defineField({
      name: "text",
      title: "Text",
      type: "string",
    }),
    defineField({
      name: "socialLink",
      title: "Social Links",
      type: "array",
      of: [{ type: "link" }],
    }),
  ],
  preview: {
    prepare() {
      return { title: "Footer" };
    },
  },
});
