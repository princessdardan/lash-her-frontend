import { defineField, defineType } from "sanity";

export const hours = defineType({
  name: "hours",
  title: "Hours",
  type: "object",
  fields: [
    defineField({
      name: "days",
      title: "Days",
      type: "string",
    }),
    defineField({
      name: "times",
      title: "Times",
      type: "string",
    }),
  ],
  preview: {
    select: {
      title: "days",
      subtitle: "times",
    },
  },
});
