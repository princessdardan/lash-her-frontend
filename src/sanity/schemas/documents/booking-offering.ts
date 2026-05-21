import { CalendarIcon } from "@sanity/icons";
import { defineField, defineType } from "sanity";

import { BOOKING_TYPE_OPTIONS } from "./booking-settings";

type BookingOfferingDocument = {
  depositAmount?: number;
  fullPrice?: number;
};

type ValidationContext = {
  document?: unknown;
};

function isBookingOfferingDocument(value: unknown): value is BookingOfferingDocument {
  return typeof value === "object" && value !== null;
}

function getDocument(context: ValidationContext): BookingOfferingDocument | undefined {
  return isBookingOfferingDocument(context.document) ? context.document : undefined;
}

function isPositiveAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validateDepositAmount(value: unknown, context: ValidationContext) {
  const document = getDocument(context);
  if (value === undefined) return "Deposit amount is required.";
  if (!isPositiveAmount(value)) return "Deposit amount must be greater than zero.";
  if (isPositiveAmount(document?.fullPrice) && value >= document.fullPrice) {
    return "Deposit amount must be less than the full price.";
  }
  return true;
}

function validateFullPrice(value: unknown, context: ValidationContext) {
  const document = getDocument(context);
  if (value === undefined) return "Full price is required.";
  if (!isPositiveAmount(value)) return "Full price must be greater than zero.";
  if (isPositiveAmount(document?.depositAmount) && value <= document.depositAmount) {
    return "Full price must be greater than the deposit amount.";
  }
  return true;
}

export const bookingOffering = defineType({
  name: "bookingOffering",
  title: "Booking Offering",
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
      name: "description",
      title: "Description",
      type: "text",
      rows: 3,
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
      name: "service",
      title: "Service",
      type: "reference",
      to: [{ type: "service" }],
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "isActive",
      title: "Active",
      type: "boolean",
      initialValue: true,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "bookingType",
      title: "Booking Type",
      type: "string",
      options: { list: BOOKING_TYPE_OPTIONS, layout: "radio" },
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
      description: "Optional per-offering lead time. Leave empty to use Booking Settings.",
      validation: (Rule) => Rule.integer().min(0).max(720),
    }),
    defineField({
      name: "depositAmount",
      title: "Deposit Amount",
      type: "number",
      validation: (Rule) => Rule.custom(validateDepositAmount),
    }),
    defineField({
      name: "fullPrice",
      title: "Full Price",
      type: "number",
      validation: (Rule) => Rule.custom(validateFullPrice),
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
      name: "displayOrder",
      title: "Display Order",
      type: "number",
      initialValue: 0,
      validation: (Rule) => Rule.integer(),
    }),
  ],
  preview: {
    select: {
      title: "title",
      subtitle: "bookingType",
    },
  },
});
