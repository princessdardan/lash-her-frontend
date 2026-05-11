import { defineField, defineType, defineArrayMember } from "sanity";

export const trainingProgram = defineType({
  name: "trainingProgram",
  title: "Training Program",
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
      name: "slug",
      title: "Slug",
      type: "slug",
      options: {
        source: "title",
      },
    }),
    defineField({
      name: "detailHeading",
      title: "Detail Section Heading",
      type: "string",
      group: "details",
    }),
    defineField({
      name: "detailDescription",
      title: "Detail Section Description",
      type: "text",
      group: "details",
    }),
    defineField({
      name: "detailItems",
      title: "Detail Items",
      type: "array",
      group: "details",
      of: [
        defineArrayMember({
          type: "object",
          fields: [
            defineField({ name: "title", title: "Title", type: "string" }),
            defineField({ name: "description", title: "Description", type: "text" }),
            defineField({
              name: "image",
              title: "Image",
              type: "image",
              options: { hotspot: true },
              fields: [
                defineField({ name: "alt", title: "Alt text", type: "string" }),
              ],
            }),
          ],
        }),
      ],
    }),
    defineField({
      name: "factList",
      title: "Fact List",
      type: "array",
      group: "details",
      of: [defineArrayMember({ type: "string" })],
    }),
    defineField({
      name: "primaryCta",
      title: "Primary CTA",
      type: "object",
      group: "details",
      fields: [
        defineField({ name: "label", title: "Label", type: "string" }),
        defineField({
          name: "href",
          title: "URL",
          type: "string",
          validation: (Rule) => Rule.custom((value) => {
            if (!value) return true;
            if (value.startsWith('https://')) return true;
            if (value.startsWith('/') && !value.startsWith('//')) return true;
            return 'URL must start with "https://" or "/" (but not "//").';
          })
        }),
      ],
    }),
    defineField({
      name: "blocks",
      title: "Blocks",
      type: "array",
      group: "legacy",
      of: [
        { type: "heroSection" },
        { type: "infoSection" },
        { type: "contactFormLabels" },
      ],
    }),
    defineField({
      name: "seo",
      title: "SEO",
      type: "object",
      group: "seo",
      fields: [
        defineField({ name: "title", title: "SEO Title", type: "string" }),
        defineField({ name: "description", title: "SEO Description", type: "text" }),
        defineField({
          name: "image",
          title: "SEO Image",
          type: "image",
          options: { hotspot: true },
        }),
      ],
    }),
  ],
  groups: [
    { name: "details", title: "Details" },
    { name: "legacy", title: "Legacy Blocks" },
    { name: "seo", title: "SEO" },
  ],
  preview: {
    select: {
      title: "title",
      subtitle: "slug.current",
    },
  },
});
