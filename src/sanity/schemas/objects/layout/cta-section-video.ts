import { defineField, defineType } from "sanity";

export const ctaSectionVideo = defineType({
  name: "ctaSectionVideo",
  title: "CTA Section (Video)",
  type: "object",
  fields: [
    defineField({
      name: "title",
      title: "Title",
      type: "string",
    }),
    defineField({
      name: "description",
      title: "Description",
      type: "text",
    }),
    defineField({
      name: "video",
      title: "Video",
      type: "file",
      options: { accept: "video/*" },
    }),
    defineField({
      name: "link",
      title: "Links",
      type: "array",
      of: [{ type: "link" }],
    }),
  ],
  preview: {
    select: {
      title: "title",
    },
  },
});
