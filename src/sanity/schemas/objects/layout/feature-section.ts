import { defineArrayMember, defineField, defineType } from "sanity";

export const featureSection = defineType({
  name: "featureSection",
  title: "Feature Section",
  type: "object",
  fields: [
    defineField({
      name: "layout",
      title: "Layout",
      type: "string",
      options: {
        list: [
          { title: "Image Left, Content Right", value: "imageLeft" },
          { title: "Image Right, Content Left", value: "imageRight" },
          { title: "Image Top, Content Below", value: "imageTop" },
        ],
      },
      initialValue: "imageLeft",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "enableCarousel",
      title: "Enable Carousel",
      type: "boolean",
      description: "When enabled, multiple feature items will auto-rotate on a timer.",
      initialValue: false,
    }),
    defineField({
      name: "carouselIntervalMs",
      title: "Carousel Interval (ms)",
      type: "number",
      description: "Time between slides in milliseconds. Default: 5000 (5 seconds).",
      initialValue: 5000,
      hidden: ({ parent }) => !parent?.enableCarousel,
    }),
    defineField({
      name: "items",
      title: "Feature Items",
      type: "array",
      of: [
        defineArrayMember({
          type: "object",
          name: "featureItem",
          title: "Feature Item",
          fields: [
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
              validation: (Rule) => Rule.required(),
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
              validation: (Rule) => Rule.required(),
            }),
            defineField({
              name: "link",
              title: "CTA Link",
              type: "object",
              fields: [
                defineField({
                  name: "href",
                  title: "URL",
                  type: "string",
                }),
                defineField({
                  name: "label",
                  title: "Label",
                  type: "string",
                }),
                defineField({
                  name: "isExternal",
                  title: "Open in new tab",
                  type: "boolean",
                  initialValue: false,
                }),
              ],
            }),
            defineField({
              name: "product",
              title: "Linked Product",
              type: "reference",
              to: [{ type: "product" }],
              description: "Optional: link to an existing product. When set, the product's image and details will be used, and the CTA will link to the product page.",
            }),
          ],
          preview: {
            select: {
              title: "heading",
              subtitle: "subHeading",
              media: "image",
            },
          },
        }),
      ],
    }),
  ],
  preview: {
    select: {
      title: "items.0.heading",
      subtitle: "layout",
    },
    prepare({ title, subtitle }) {
      return {
        title: title || "Feature Section",
        subtitle: subtitle ? `Layout: ${subtitle}` : "",
      };
    },
  },
});
