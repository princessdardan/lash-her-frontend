import { defineField, defineType } from "sanity";

export const feature = defineType({
  name: "feature",
  title: "Feature",
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
      type: "text",
    }),
    defineField({
      name: "icon",
      title: "Icon",
      type: "string",
      options: {
        list: [
          { title: "Eye Icon", value: "EYE_ICON" },
          { title: "Sparkles Icon", value: "SPARKLES_ICON" },
          { title: "Star Icon", value: "STAR_ICON" },
        ],
      },
    }),
  ],
  preview: {
    select: {
      title: "heading",
    },
  },
});
