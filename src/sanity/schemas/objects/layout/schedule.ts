import { defineField, defineType } from "sanity";

export const schedule = defineType({
  name: "schedule",
  title: "Schedule",
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
      name: "hours",
      title: "Hours",
      type: "array",
      of: [{ type: "hours" }],
    }),
  ],
  preview: {
    select: {
      title: "heading",
    },
  },
});
