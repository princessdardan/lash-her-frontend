import { CalendarIcon } from "@sanity/icons";
import { defineArrayMember, defineField, defineType } from "sanity";

type ServiceCommerceDocument = {
  fullPrice?: number;
  depositAmount?: number;
};

function isServiceCommerceDocument(value: unknown): value is ServiceCommerceDocument {
  return typeof value === "object" && value !== null;
}

function getServiceDocument(value: unknown): ServiceCommerceDocument | undefined {
  return isServiceCommerceDocument(value) ? value : undefined;
}

function validateDepositAmount(value: unknown, context: { document?: unknown }) {
  const document = getServiceDocument(context.document);

  if (typeof value !== "number") return "Deposit amount is required.";

  if (!Number.isFinite(value) || value <= 0) {
    return "Deposit amount must be greater than zero.";
  }

  if (typeof document?.fullPrice === "number" && value >= document.fullPrice) {
    return "Deposit amount must be less than the full price.";
  }

  return true;
}

function validateFullPrice(value: unknown, context: { document?: unknown }) {
  const document = getServiceDocument(context.document);

  if (typeof value !== "number") return "Full price is required.";

  if (!Number.isFinite(value) || value <= 0) {
    return "Full price must be greater than zero.";
  }

  if (typeof document?.depositAmount === "number" && value <= document.depositAmount) {
    return "Full price must be greater than the deposit amount.";
  }

  return true;
}

export const service = defineType({
  name: "service",
  title: "Service",
  type: "document",
  icon: CalendarIcon,
  groups: [
    { name: "overview", title: "Overview" },
    { name: "booking", title: "Booking" },
    { name: "pricing", title: "Pricing" },
    { name: "media", title: "Media" },
    { name: "details", title: "Details" },
    { name: "seo", title: "SEO" },
  ],
  fields: [
    defineField({ name: "title", title: "Title", type: "string", group: "overview", validation: (Rule) => Rule.required() }),
    defineField({ name: "slug", title: "Slug", type: "slug", group: "overview", options: { source: "title" }, validation: (Rule) => Rule.required() }),
    defineField({ name: "description", title: "Description", type: "text", group: "overview", rows: 3, validation: (Rule) => Rule.required() }),
    defineField({ name: "shortDescription", title: "Short Description", type: "text", group: "overview" }),
    defineField({ name: "showDetailPage", title: "Show Detail Page", type: "boolean", group: "overview", initialValue: true, validation: (Rule) => Rule.required() }),
    defineField({ name: "isAvailable", title: "Available for booking", type: "boolean", group: "overview", initialValue: true, validation: (Rule) => Rule.required() }),
    defineField({ name: "displayOrder", title: "Display Order", type: "number", group: "overview", initialValue: 0, validation: (Rule) => Rule.integer() }),
    defineField({ name: "durationMinutes", title: "Duration Minutes", type: "number", group: "booking", validation: (Rule) => Rule.required().integer().min(15).max(240) }),
    defineField({ name: "fullPrice", title: "Full Price", type: "number", group: "pricing", validation: (Rule) => Rule.custom(validateFullPrice) }),
    defineField({ name: "depositAmount", title: "Deposit Amount", type: "number", group: "pricing", validation: (Rule) => Rule.custom(validateDepositAmount) }),
    defineField({ name: "currency", title: "Currency", type: "string", group: "pricing", initialValue: "CAD", readOnly: true, validation: (Rule) => Rule.required() }),
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
          fields: [defineField({ name: "alt", title: "Alt text", type: "string" })],
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
        defineField({ name: "description", title: "SEO Description", type: "text" }),
        defineField({ name: "image", title: "SEO Image", type: "image", options: { hotspot: true } }),
      ],
    }),
  ],
  preview: {
    select: { title: "title", subtitle: "durationMinutes", media: "image" },
    prepare({ title, subtitle, media }) {
      return { title, subtitle: subtitle ? `${subtitle} minutes` : undefined, media };
    },
  },
});
