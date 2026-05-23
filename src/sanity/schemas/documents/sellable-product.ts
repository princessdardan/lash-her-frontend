import { defineField, defineType, defineArrayMember } from "sanity";

export const sellableProduct = defineType({
  name: "sellableProduct",
  title: "Sellable Product",
  type: "document",
  fields: [
    defineField({
      name: "title",
      title: "Title",
      type: "string",
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
      name: "cardSubtitle",
      title: "Card Subtitle",
      type: "string",
      description: "Short catalog card label, such as retention or finish details.",
    }),
    defineField({
      name: "badgeLabel",
      title: "Badge Label",
      type: "string",
      description: "Optional merchandising label, such as Best Seller or New.",
    }),
    defineField({
      name: "slug",
      title: "Slug",
      type: "slug",
      options: {
        source: "title",
      },
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "sku",
      title: "SKU",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "kind",
      title: "Kind",
      type: "string",
      options: {
        list: [
          { title: "Product", value: "product" },
          { title: "Service", value: "service" },
          { title: "Training", value: "training" },
          { title: "Deposit", value: "deposit" },
        ],
        layout: "radio",
      },
      initialValue: "service",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "price",
      title: "Price",
      type: "number",
      validation: (Rule) => Rule.required().min(0),
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
      name: "collections",
      title: "Collections",
      type: "array",
      of: [
        defineArrayMember({
          type: "reference",
          to: [{ type: "productCollection" }],
        }),
      ],
    }),
    defineField({
      name: "filterAttributes",
      title: "Filter Attributes",
      type: "array",
      description: "Catalog filter facts such as diameter, curl, finish, or style.",
      of: [
        defineArrayMember({
          type: "object",
          title: "Filter Attribute",
          fields: [
            defineField({ name: "label", title: "Label", type: "string" }),
            defineField({ name: "value", title: "Value", type: "string" }),
          ],
          preview: {
            select: { title: "label", subtitle: "value" },
          },
        }),
      ],
    }),
    defineField({
      name: "optionGroups",
      title: "Option Groups",
      type: "array",
      description: "Groups used by the product detail option UI, such as Curl or Diameter.",
      of: [
        defineArrayMember({
          type: "object",
          title: "Option Group",
          fields: [
            defineField({ name: "name", title: "Name", type: "string" }),
            defineField({
              name: "values",
              title: "Values",
              type: "array",
              of: [defineArrayMember({ type: "string" })],
            }),
          ],
          preview: {
            select: { title: "name", values: "values" },
            prepare({ title, values }) {
              const optionCount = Array.isArray(values) ? values.length : 0;
              return {
                title,
                subtitle: `${optionCount} value${optionCount === 1 ? "" : "s"}`,
              };
            },
          },
        }),
      ],
    }),
    defineField({
      name: "variants",
      title: "Variants",
      type: "array",
      description: "Add purchasable options such as size, style, deposit type, or training format. If variants are present, shoppers must choose one before checkout.",
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
              name: "sku",
              title: "Variant SKU",
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
              description: "Optional label for this option, e.g., 'In Stock', 'Sold Out', or 'Limited spots'.",
            }),
            defineField({
              name: "options",
              title: "Options",
              type: "array",
              description: "Name/value pairs that connect this variant to option groups.",
              of: [
                defineArrayMember({
                  type: "object",
                  title: "Option",
                  fields: [
                    defineField({ name: "name", title: "Name", type: "string" }),
                    defineField({ name: "value", title: "Value", type: "string" }),
                  ],
                  preview: {
                    select: { title: "name", subtitle: "value" },
                  },
                }),
              ],
            }),
          ],
          preview: {
            select: {
              title: "title",
              sku: "sku",
              price: "price",
              isAvailable: "isAvailable",
            },
            prepare({ title, sku, price, isAvailable }) {
              const amount = typeof price === "number" ? `$${price.toFixed(2)}` : "No price";
              return {
                title,
                subtitle: `${sku || "No SKU"} · ${amount}${isAvailable === false ? " · Unavailable" : ""}`,
              };
            },
          },
        }),
      ],
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
      description: "e.g., 'In Stock', 'Out of Stock', 'Pre-order'",
    }),
    defineField({
      name: "fulfillmentNote",
      title: "Fulfillment Note",
      type: "text",
      description: "e.g., 'Available for pickup only'",
    }),
    defineField({
      name: "displayOrder",
      title: "Display Order",
      type: "number",
      initialValue: 0,
    }),
    defineField({
      name: "image",
      title: "Image",
      type: "image",
      options: {
        hotspot: true,
      },
      fields: [
        defineField({
          name: "alt",
          title: "Alt text",
          type: "string",
        }),
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
      name: "detailSections",
      title: "Detail Sections",
      type: "array",
      of: [
        defineArrayMember({
          type: "object",
          fields: [
            defineField({ name: "heading", title: "Heading", type: "string" }),
            defineField({ name: "content", title: "Content", type: "text" }),
            defineField({
              name: "body",
              title: "Rich Content",
              type: "array",
              description: "Optional rich replacement for Content. Existing plain text content is preserved.",
              of: [
                defineArrayMember({
                  type: "block",
                  lists: [
                    { title: "Bullet", value: "bullet" },
                    { title: "Numbered", value: "number" },
                  ],
                }),
              ],
            }),
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
      subtitle: "sku",
      media: "image",
    },
  },
});
