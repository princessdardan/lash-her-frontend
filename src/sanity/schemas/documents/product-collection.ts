import { defineField, defineType } from "sanity";

export const productCollection = defineType({
  name: "productCollection",
  title: "Product Collection",
  type: "document",
  groups: [
    { name: "overview", title: "Overview" },
    { name: "catalog", title: "Catalog" },
  ],
  fields: [
    defineField({
      name: "title",
      title: "Title",
      type: "string",
      group: "overview",
    }),
    defineField({
      name: "slug",
      title: "Slug",
      type: "slug",
      group: "overview",
      options: {
        source: "title",
      },
    }),
    defineField({
      name: "description",
      title: "Description",
      type: "text",
      group: "overview",
    }),
    defineField({
      name: "displayOrder",
      title: "Display Order",
      type: "number",
      group: "catalog",
    }),
  ],
  orderings: [
    {
      title: "Display Order",
      name: "displayOrderAsc",
      by: [{ field: "displayOrder", direction: "asc" }],
    },
  ],
  preview: {
    select: {
      title: "title",
      subtitle: "slug.current",
    },
  },
});
