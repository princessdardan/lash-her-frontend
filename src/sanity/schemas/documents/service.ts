import { CalendarIcon } from "@sanity/icons";
import { defineArrayMember, defineField, defineType } from "sanity";

export function canonicalizeServiceSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
}

export const service = defineType({
  name: "service",
  title: "Service",
  type: "document",
  icon: CalendarIcon,
  groups: [
    { name: "overview", title: "Overview" },
    { name: "media", title: "Media" },
    { name: "details", title: "Details" },
    { name: "seo", title: "SEO" },
  ],
  fields: [
    defineField({
      name: "title",
      title: "Title",
      type: "string",
      group: "overview",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "slug",
      title: "Slug",
      type: "slug",
      group: "overview",
      options: {
        source: "title",
        slugify: canonicalizeServiceSlug,
      },
      validation: (Rule) =>
        Rule.required().custom((value) => {
          const current = value?.current;
          if (typeof current !== "string") return true;

          const canonical = canonicalizeServiceSlug(current);
          if (current === canonical) return true;

          return canonical
            ? `Use the lowercase URL slug "${canonical}".`
            : "Enter a URL slug using lowercase letters, numbers, and hyphens.";
        }),
    }),
    defineField({
      name: "description",
      title: "Description",
      type: "text",
      group: "overview",
      rows: 3,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "shortDescription",
      title: "Short Description",
      type: "text",
      group: "overview",
    }),
    defineField({
      name: "image",
      title: "Image",
      type: "image",
      group: "media",
      options: { hotspot: true },
      fields: [defineField({ name: "alt", title: "Alt text", type: "string" })],
    }),
    defineField({
      name: "gallery",
      title: "Gallery Images",
      type: "array",
      group: "media",
      of: [
        defineArrayMember({
          type: "image",
          options: { hotspot: true },
          fields: [
            defineField({ name: "alt", title: "Alt text", type: "string" }),
          ],
        }),
      ],
    }),
    defineField({
      name: "detailSections",
      title: "Detail Sections",
      type: "array",
      group: "details",
      of: [
        defineArrayMember({
          type: "object",
          fields: [
            defineField({ name: "heading", title: "Heading", type: "string" }),
            defineField({ name: "content", title: "Content", type: "text" }),
          ],
        }),
      ],
    }),
    defineField({
      name: "seo",
      title: "SEO",
      type: "object",
      group: "seo",
      fields: [
        defineField({ name: "title", title: "SEO Title", type: "string" }),
        defineField({
          name: "description",
          title: "SEO Description",
          type: "text",
        }),
        defineField({
          name: "image",
          title: "SEO Image",
          type: "image",
          options: { hotspot: true },
        }),
      ],
    }),
  ],
  preview: {
    select: { title: "title", subtitle: "shortDescription", media: "image" },
  },
});
