import { CalendarIcon } from "@sanity/icons";
import { defineField, defineType } from "sanity";

import { BOOKING_TYPE_OPTIONS } from "./booking-settings";

export const BOOKING_OFFERING_PAYMENT_MODE_OPTIONS = [
  { title: "Deposit", value: "deposit" },
  { title: "Full payment", value: "full" },
  { title: "Custom partial payment", value: "customPartial" },
];

type BookingOfferingDocument = {
  paymentMode?: string;
  fullPrice?: number;
  customAmountMinimum?: number;
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
  if (document?.paymentMode !== "deposit") return true;
  if (value === undefined) return "Deposit payment mode requires a positive deposit amount.";
  return isPositiveAmount(value) ? true : "Deposit amount must be greater than zero.";
}

function validateFullPrice(value: unknown, context: ValidationContext) {
  const document = getDocument(context);
  if (document?.paymentMode !== "full" && document?.paymentMode !== "customPartial") return true;
  if (value === undefined) return "Full payment and custom partial modes require a positive full price.";
  return isPositiveAmount(value) ? true : "Full price must be greater than zero.";
}

function validateCustomAmountMinimum(value: unknown, context: ValidationContext) {
  const document = getDocument(context);
  if (document?.paymentMode !== "customPartial") return true;
  if (value === undefined) return "Custom partial mode requires a positive minimum amount.";
  if (!isPositiveAmount(value)) return "Custom partial minimum must be greater than zero.";
  if (isPositiveAmount(document.fullPrice) && value >= document.fullPrice) {
    return "Custom partial minimum must be less than the full price.";
  }
  return true;
}

function validateCustomAmountMaximum(value: unknown, context: ValidationContext) {
  const document = getDocument(context);
  if (document?.paymentMode !== "customPartial") return true;
  if (value === undefined) return "Custom partial mode requires a maximum amount greater than the minimum.";
  if (!isPositiveAmount(value)) return "Custom partial maximum must be greater than zero.";
  if (isPositiveAmount(document.customAmountMinimum) && value <= document.customAmountMinimum) {
    return "Custom partial maximum must be greater than the minimum.";
  }
  if (isPositiveAmount(document.fullPrice) && value > document.fullPrice) {
    return "Custom partial maximum cannot exceed the full price.";
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
      name: "paymentMode",
      title: "Payment Mode",
      type: "string",
      options: { list: BOOKING_OFFERING_PAYMENT_MODE_OPTIONS, layout: "radio" },
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "depositAmount",
      title: "Deposit Amount",
      type: "number",
      hidden: ({ document }) => document?.paymentMode !== "deposit",
      validation: (Rule) => Rule.custom(validateDepositAmount),
    }),
    defineField({
      name: "fullPrice",
      title: "Full Price",
      type: "number",
      hidden: ({ document }) => document?.paymentMode === "deposit",
      validation: (Rule) => Rule.custom(validateFullPrice),
    }),
    defineField({
      name: "allowCustomAmount",
      title: "Allow Custom Amount",
      type: "boolean",
      initialValue: false,
      hidden: ({ document }) => document?.paymentMode !== "customPartial",
    }),
    defineField({
      name: "customAmountMinimum",
      title: "Custom Amount Minimum",
      type: "number",
      hidden: ({ document }) => document?.paymentMode !== "customPartial",
      validation: (Rule) => Rule.custom(validateCustomAmountMinimum),
    }),
    defineField({
      name: "customAmountMaximum",
      title: "Custom Amount Maximum",
      type: "number",
      hidden: ({ document }) => document?.paymentMode !== "customPartial",
      validation: (Rule) => Rule.custom(validateCustomAmountMaximum),
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
