import { CalendarIcon } from "@sanity/icons";
import { defineArrayMember, defineField, defineType } from "sanity";

const SERVICE_BOOKING_TYPE_OPTIONS = [
  { title: "In-person appointment", value: "in-person-appointment" },
];

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
      rows: 3,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "shortDescription",
      title: "Short Description",
      type: "text",
    }),
    defineField({
      name: "showDetailPage",
      title: "Show Detail Page",
      type: "boolean",
      initialValue: true,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "bookingType",
      title: "Booking Type",
      type: "string",
      options: { list: SERVICE_BOOKING_TYPE_OPTIONS, layout: "radio" },
      initialValue: "in-person-appointment",
      readOnly: true,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "durationMinutes",
      title: "Duration Minutes",
      type: "number",
      validation: (Rule) => Rule.required().integer().min(15).max(240),
    }),
    defineField({
      name: "slotIntervalMinutes",
      title: "Slot Interval Minutes",
      type: "number",
      validation: (Rule) => Rule.required().integer().min(5).max(120),
    }),
    defineField({
      name: "bufferBeforeMinutes",
      title: "Buffer Before Minutes",
      type: "number",
      initialValue: 0,
      validation: (Rule) => Rule.required().integer().min(0).max(120),
    }),
    defineField({
      name: "bufferAfterMinutes",
      title: "Buffer After Minutes",
      type: "number",
      initialValue: 0,
      validation: (Rule) => Rule.required().integer().min(0).max(120),
    }),
    defineField({
      name: "minimumLeadTimeHoursOverride",
      title: "Minimum Lead Time Hours Override",
      type: "number",
      description: "Optional per-service lead time. Leave empty to use Booking Settings.",
      validation: (Rule) => Rule.integer().min(0).max(720),
    }),
    defineField({
      name: "fullPrice",
      title: "Full Price",
      type: "number",
      validation: (Rule) => Rule.custom(validateFullPrice),
    }),
    defineField({
      name: "depositAmount",
      title: "Deposit Amount",
      type: "number",
      validation: (Rule) => Rule.custom(validateDepositAmount),
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
      title: "Available for booking",
      type: "boolean",
      initialValue: true,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "availabilityLabel",
      title: "Availability Label",
      type: "string",
      description: "e.g., 'Now booking', 'Waitlist', or 'Limited availability'.",
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
