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
    defineField({
      name: "checkoutEnabled",
      title: "Enable Online Checkout",
      type: "boolean",
      group: "commerce",
      initialValue: false,
    }),
    defineField({
      name: "checkoutProduct",
      title: "Checkout Product",
      type: "reference",
      to: [{ type: "sellableProduct" }],
      group: "commerce",
      hidden: ({ document }) => !document?.checkoutEnabled,
      validation: (Rule) => Rule.custom((value, context) => {
        if (context.document?.checkoutEnabled && !value) {
          return "A checkout product is required when checkout is enabled.";
        }
        // TODO: Cross-document validation to ensure product kind is "training"
        return true;
      }),
    }),
    defineField({
      name: "checkoutCtaLabel",
      title: "Checkout CTA Label",
      type: "string",
      group: "commerce",
      initialValue: "Enroll Now",
      hidden: ({ document }) => !document?.checkoutEnabled,
    }),
    defineField({
      name: "checkoutDisabledBookingCta",
      title: "Disabled Checkout Booking CTA",
      type: "object",
      group: "commerce",
      hidden: ({ document }) => !!document?.checkoutEnabled,
      fields: [
        defineField({ name: "label", title: "Label", type: "string", initialValue: "Book a Call" }),
        defineField({ 
          name: "href", 
          title: "URL", 
          type: "string", 
          initialValue: "/booking?type=training-call",
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
      name: "postPurchaseInstructions",
      title: "Post-Purchase Instructions",
      type: "text",
      group: "commerce",
      hidden: ({ document }) => !document?.checkoutEnabled,
    }),
  ],
  groups: [
    { name: "details", title: "Details" },
    { name: "commerce", title: "Commerce" },
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
