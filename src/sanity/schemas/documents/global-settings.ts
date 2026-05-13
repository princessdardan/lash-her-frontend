import { defineField, defineType } from "sanity";

export const globalSettings = defineType({
  name: "globalSettings",
  title: "Global Settings",
  type: "document",
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
      name: "ogImage",
      title: "Open Graph Image",
      type: "image",
      description: "Default social sharing image (recommended: 1200 x 630px)",
      options: { hotspot: false },
    }),
    defineField({
      name: "header",
      title: "Header",
      type: "header",
    }),
    defineField({
      name: "footer",
      title: "Footer",
      type: "footer",
    }),
  ],
  preview: {
    select: {
      title: "title",
    },
  },
});
