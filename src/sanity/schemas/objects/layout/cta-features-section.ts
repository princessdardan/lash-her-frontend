import { defineField, defineType } from "sanity";

export const ctaFeaturesSection = defineType({
  name: "ctaFeaturesSection",
  title: "CTA Features Section",
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
      name: "description",
      title: "Description",
      type: "text",
    }),
    defineField({
      name: "features",
      title: "Features",
      type: "array",
      of: [{ type: "ctaFeature" }],
    }),
  ],
  preview: {
    select: {
      title: "heading",
    },
  },
});
