import { defineField, defineType } from "sanity";

export const galleryPage = defineType({
  name: "galleryPage",
  title: "Gallery",
  type: "document",
  groups: [
    { name: "overview", title: "Overview" },
    { name: "content", title: "Content" },
  ],
  fields: [
    defineField({
      name: "title",
      title: "Title",
      type: "string",
      group: "overview",
    }),
    defineField({
      name: "description",
      title: "Description",
      type: "text",
      group: "overview",
    }),
    defineField({
      name: "blocks",
      title: "Blocks",
      type: "array",
      group: "content",
      of: [{ type: "photoGallery" }, { type: "heroSection" }],
    }),
  ],
  preview: {
    select: {
      title: "title",
    },
  },
});
