import { defineField, defineType } from "sanity";

export const galleryPage = defineType({
  name: "galleryPage",
  title: "Gallery",
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
      name: "blocks",
      title: "Blocks",
      type: "array",
      of: [{ type: "photoGallery" }, { type: "heroSection" }],
    }),
  ],
  preview: {
    select: {
      title: "title",
    },
  },
});
