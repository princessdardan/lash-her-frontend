import { defineField, defineType } from "sanity";

export const header = defineType({
  name: "header",
  title: "Header",
  type: "object",
  fields: [
    defineField({
      name: "logoText",
      title: "Logo Text",
      type: "link",
    }),
    defineField({
      name: "ctaButton",
      title: "CTA Button",
      type: "array",
      of: [{ type: "link" }],
    }),
  ],
  preview: {
    prepare() {
      return { title: "Header" };
    },
  },
});
