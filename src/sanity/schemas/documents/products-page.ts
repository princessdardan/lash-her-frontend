import { defineArrayMember, defineField, defineType } from "sanity";

export const productsPage = defineType({
  name: "productsPage",
  title: "Products Page",
  type: "document",
  groups: [
    { name: "overview", title: "Overview" },
    { name: "media", title: "Media" },
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
      name: "eyebrow",
      title: "Eyebrow",
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
      name: "heroImage",
      title: "Hero Image",
      type: "image",
      group: "media",
      options: { hotspot: true },
      fields: [
        defineField({ name: "alt", title: "Alt text", type: "string" }),
      ],
    }),
    defineField({
      name: "featuredCollections",
      title: "Featured Collections",
      type: "array",
      group: "catalog",
      of: [
        defineArrayMember({
          type: "reference",
          to: [{ type: "productCollection" }],
        }),
      ],
    }),
    defineField({
      name: "emptyStateTitle",
      title: "Empty State Title",
      type: "string",
      group: "catalog",
    }),
    defineField({
      name: "emptyStateDescription",
      title: "Empty State Description",
      type: "text",
      group: "catalog",
    }),
  ],
  preview: {
    select: {
      title: "title",
      media: "heroImage",
    },
  },
});
