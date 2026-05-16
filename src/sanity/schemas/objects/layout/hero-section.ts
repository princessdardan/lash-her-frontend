import { defineField, defineType, defineArrayMember } from "sanity";

export const heroSection = defineType({
  name: "heroSection",
  title: "Hero Section",
  type: "object",
  fields: [
    defineField({
      name: "heroSize",
      title: "Hero Size",
      type: "string",
      options: {
        list: [
          { title: "Default / Contextual", value: "default" },
          { title: "Full Screen", value: "fullScreen" },
          { title: "80% Viewport", value: "eighty" },
          { title: "Compact / Internal", value: "compact" },
        ],
        layout: "radio",
      },
      initialValue: "default",
      description: "Overrides the default sizing behavior.",
    }),
    defineField({
      name: "image",
      title: "Image",
      type: "image",
      options: { hotspot: true },
      fields: [
        defineField({
          name: "alt",
          title: "Alternative Text",
          type: "string",
        }),
      ],
    }),
    defineField({
      name: "heading",
      title: "Heading",
      type: "string",
    }),
    defineField({
      name: "subHeading",
      title: "Sub Heading",
      type: "text",
    }),
    defineField({
      name: "link",
      title: "Links",
      type: "array",
      of: [{ type: "link" }],
    }),
    defineField({
      name: "description",
      title: "Description",
      type: "text",
    }),
    defineField({
      name: "onHomepage",
      title: "On Homepage",
      type: "boolean",
      initialValue: false,
    }),
    defineField({
      name: "slides",
      title: "Carousel Slides",
      type: "array",
      description: "Optional. If provided, the hero will become a carousel.",
      validation: (Rule) => Rule.max(6).warning("Keep carousels focused with six slides or fewer."),
      of: [
        defineArrayMember({
          type: "object",
          name: "slide",
          fields: [
            defineField({
              name: "image",
              title: "Image",
              type: "image",
              options: { hotspot: true },
              validation: (Rule) => Rule.required(),
              fields: [
                defineField({
                  name: "alt",
                  title: "Alternative Text",
                  type: "string",
                }),
              ],
            }),
            defineField({
              name: "heading",
              title: "Heading",
              type: "string",
            }),
            defineField({
              name: "subHeading",
              title: "Sub Heading",
              type: "text",
            }),
            defineField({
              name: "description",
              title: "Description",
              type: "text",
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
              title: "heading",
              media: "image",
            },
          },
        }),
      ],
    }),
    defineField({
      name: "autoRotate",
      title: "Auto Rotate Carousel",
      type: "boolean",
      initialValue: false,
      hidden: ({ parent }) => !parent?.slides || parent.slides.length === 0,
    }),
    defineField({
      name: "rotationIntervalMs",
      title: "Rotation Interval (ms)",
      type: "number",
      initialValue: 5000,
      validation: (Rule) => Rule.min(3000).max(15000),
      hidden: ({ parent }) => !parent?.autoRotate,
    }),
  ],
  preview: {
    select: {
      title: "heading",
    },
  },
});
