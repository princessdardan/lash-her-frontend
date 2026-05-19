import { CalendarIcon } from "@sanity/icons";
import { defineField, defineType } from "sanity";

import { BOOKING_TYPE_OPTIONS } from "./booking-settings";

const SANITY_API_VERSION = "2026-03-24";

export const BOOKING_OFFERING_PAYMENT_MODE_OPTIONS = [
  { title: "Deposit", value: "deposit" },
  { title: "Full payment", value: "full" },
  { title: "Customer choice", value: "choice" },
];

type SellableProductReference = {
  _ref: string;
};

type BookingOfferingDocument = {
  paymentMode?: string;
  depositProduct?: SellableProductReference;
  fullProduct?: SellableProductReference;
};

type ProductValidationProjection = {
  kind?: string;
  price?: number;
};

type ValidationContext = {
  document?: unknown;
  getClient: (config: { apiVersion: string }) => {
    fetch: <T>(query: string, params: Record<string, string>) => Promise<T>;
  };
};

function isSellableProductReference(value: unknown): value is SellableProductReference {
  return (
    typeof value === "object" &&
    value !== null &&
    "_ref" in value &&
    typeof value._ref === "string" &&
    value._ref.length > 0
  );
}

function isBookingOfferingDocument(value: unknown): value is BookingOfferingDocument {
  return typeof value === "object" && value !== null;
}

async function getValidationProduct(
  context: ValidationContext,
  productId: string,
): Promise<ProductValidationProjection | null> {
  return context
    .getClient({ apiVersion: SANITY_API_VERSION })
    .fetch<ProductValidationProjection | null>(
      `*[_id == $productId][0]{
        kind,
        price
      }`,
      { productId },
    );
}

async function validateDepositProduct(value: unknown, context: ValidationContext) {
  const document = isBookingOfferingDocument(context.document) ? context.document : undefined;

  if ((document?.paymentMode === "deposit" || document?.paymentMode === "choice") && !value) {
    return "A deposit product is required for deposit and choice payment modes.";
  }

  if (!value) return true;

  if (!isSellableProductReference(value)) {
    return "Choose a valid deposit product reference before publishing.";
  }

  const product = await getValidationProduct(context, value._ref);

  if (!product) {
    return "The selected deposit product could not be found. Choose an existing deposit product.";
  }

  if (product.kind !== "deposit") {
    return "Deposit product must reference a sellable product with Kind set to Deposit.";
  }

  return true;
}

async function validateFullProduct(value: unknown, context: ValidationContext) {
  const document = isBookingOfferingDocument(context.document) ? context.document : undefined;

  if ((document?.paymentMode === "full" || document?.paymentMode === "choice") && !value) {
    return "A full payment product is required for full and choice payment modes.";
  }

  if (!value) return true;

  if (!isSellableProductReference(value)) {
    return "Choose a valid full payment product reference before publishing.";
  }

  const product = await getValidationProduct(context, value._ref);

  if (!product) {
    return "The selected full payment product could not be found. Choose an existing service product.";
  }

  if (product.kind !== "service" && product.kind !== "deposit") {
    return "Full payment product must reference a sellable product with Kind set to Service or Deposit.";
  }

  return true;
}

async function validatePaymentMode(value: unknown, context: ValidationContext) {
  if (value !== "choice") return true;

  const document = isBookingOfferingDocument(context.document) ? context.document : undefined;

  if (!isSellableProductReference(document?.depositProduct) || !isSellableProductReference(document?.fullProduct)) {
    return "Choice payment mode requires both deposit and full payment products.";
  }

  const [depositProduct, fullProduct] = await Promise.all([
    getValidationProduct(context, document.depositProduct._ref),
    getValidationProduct(context, document.fullProduct._ref),
  ]);

  if (typeof depositProduct?.price !== "number" || typeof fullProduct?.price !== "number") {
    return "Choice payment mode requires priced deposit and full payment products.";
  }

  if (fullProduct.price <= depositProduct.price) {
    return "Choice payment mode requires the full payment product price to exceed the deposit product price.";
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
      validation: (Rule) => Rule.required().custom(validatePaymentMode),
    }),
    defineField({
      name: "depositProduct",
      title: "Deposit Product",
      type: "reference",
      to: [{ type: "sellableProduct" }],
      validation: (Rule) => Rule.custom(validateDepositProduct),
    }),
    defineField({
      name: "fullProduct",
      title: "Full Payment Product",
      type: "reference",
      to: [{ type: "sellableProduct" }],
      validation: (Rule) => Rule.custom(validateFullProduct),
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
