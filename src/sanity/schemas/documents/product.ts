import { defineArrayMember, defineField, defineType } from "sanity";

export const product = defineType({
  name: "product",
  title: "Product",
  type: "document",
  fields: [
    defineField({
      name: "title",
      title: "Title",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "slug",
      title: "Slug",
      type: "slug",
      options: { source: "title" },
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "description",
      title: "Description",
      type: "text",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "shortDescription",
      title: "Short Description",
      type: "text",
    }),
    defineField({
      name: "price",
      title: "Price",
      type: "number",
      validation: (Rule) => Rule.required().min(0),
    }),
    defineField({
      name: "sku",
      title: "Merchant SKU",
      type: "string",
      description: "Optional merchant-facing SKU for reconciliation. Generated fallback codes are internal and not shown to customers.",
    }),
    defineField({
      name: "currency",
      title: "Currency",
      type: "string",
      initialValue: "CAD",
      readOnly: true,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "isAvailable",
      title: "Available for checkout",
      type: "boolean",
      initialValue: true,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "availabilityLabel",
      title: "Availability Label",
      type: "string",
      description: "e.g., 'In Stock', 'Out of Stock', or 'Pre-order'.",
    }),
    defineField({
      name: "fulfillmentNote",
      title: "Fulfillment Note",
      type: "text",
      description: "e.g., pickup, delivery, digital delivery, or care instructions.",
    }),
    defineField({
      name: "displayOrder",
      title: "Display Order",
      type: "number",
      initialValue: 0,
      validation: (Rule) => Rule.integer(),
    }),
    defineField({
      name: "image",
      title: "Image",
      type: "image",
      options: { hotspot: true },
      fields: [
        defineField({ name: "alt", title: "Alt text", type: "string" }),
      ],
    }),
    defineField({
      name: "gallery",
      title: "Gallery Images",
      type: "array",
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
      name: "variants",
      title: "Variants",
      type: "array",
      description: "Optional purchasable choices such as size, finish, or format.",
      of: [
        defineArrayMember({
          type: "object",
          title: "Variant",
          fields: [
            defineField({
              name: "title",
              title: "Variant Title",
              type: "string",
              validation: (Rule) => Rule.required(),
            }),
            defineField({
              name: "price",
              title: "Variant Price",
              type: "number",
              validation: (Rule) => Rule.required().min(0),
            }),
            defineField({
              name: "sku",
              title: "Variant Merchant SKU",
              type: "string",
              description: "Optional merchant-facing SKU for reconciliation.",
            }),
            defineField({
              name: "isAvailable",
              title: "Available for checkout",
              type: "boolean",
              initialValue: true,
              validation: (Rule) => Rule.required(),
            }),
            defineField({
              name: "availabilityLabel",
              title: "Availability Label",
              type: "string",
            }),
          ],
          preview: {
            select: {
              title: "title",
              price: "price",
              isAvailable: "isAvailable",
            },
            prepare({ title, price, isAvailable }) {
              const amount = typeof price === "number" ? `$${price.toFixed(2)}` : "No price";
              return {
                title,
                subtitle: `${amount}${isAvailable === false ? " · Unavailable" : ""}`,
              };
            },
          },
        }),
      ],
    }),
    defineField({
      name: "detailSections",
      title: "Detail Sections",
      type: "array",
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
    { name: "seo", title: "SEO" },
  ],
  preview: {
    select: {
      title: "title",
      subtitle: "availabilityLabel",
      media: "image",
    },
  },
});
