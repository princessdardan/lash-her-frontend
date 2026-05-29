import { DocumentIcon } from "@sanity/icons";
import { defineArrayMember, defineField, defineType } from "sanity";

export const featureSection = defineType({
  name: "featureSection",
  title: "Feature Section",
  type: "object",
  icon: DocumentIcon,
  fields: [
    defineField({
      name: "heading",
      title: "Heading",
      type: "string",
      description: "Optional heading displayed above the featured items.",
    }),
    defineField({
      name: "subHeading",
      title: "Sub Heading",
      type: "text",
      rows: 2,
      description: "Optional supporting copy displayed below the heading.",
    }),
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
              name: "product",
              title: "Linked Product",
              type: "reference",
              to: [{ type: "product" }],
              description: "Optional: link to an existing product. When set, the product image, heading, description, and CTA destination come from the product unless manually overridden.",
            }),
            defineField({
              name: "image",
              title: "Image",
              type: "image",
              description: "Used when no product is linked, or as a fallback if the product has no image.",
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
              description: "Used when no product is linked, or as a fallback if the product has no title.",
              validation: (Rule) =>
                Rule.custom((heading, context) => {
                  const parent = context.parent as { product?: unknown } | undefined;
                  return parent?.product || heading ? true : "Heading is required when no product is linked.";
                }),
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
              description: "Used when no product is linked, or as a fallback if the product has no short description.",
              validation: (Rule) =>
                Rule.custom((description, context) => {
                  const parent = context.parent as { product?: unknown } | undefined;
                  return parent?.product || description ? true : "Description is required when no product is linked.";
                }),
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
          ],
          preview: {
            select: {
              title: "heading",
              productTitle: "product.title",
              subtitle: "subHeading",
              productSubtitle: "product.cardSubtitle",
              media: "image",
              productMedia: "product.image",
            },
            prepare({ title, productTitle, subtitle, productSubtitle, media, productMedia }) {
              return {
                title: title || productTitle || "Feature Item",
                subtitle: subtitle || productSubtitle || "Feature Item",
                media: media || productMedia,
              };
            },
          },
        }),
      ],
    }),
  ],
  preview: {
    select: {
      title: "heading",
      itemTitle: "items.0.heading",
      productTitle: "items.0.product.title",
      subtitle: "subHeading",
      layout: "layout",
    },
    prepare({ title, itemTitle, productTitle, subtitle, layout }) {
      return {
        title: title || itemTitle || productTitle || "Feature Section",
        subtitle: subtitle || (layout ? `Layout: ${layout}` : ""),
      };
    },
  },
});
