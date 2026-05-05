import { defineField, defineType } from "sanity";

export const checkoutOrder = defineType({
  name: "checkoutOrder",
  title: "Checkout Order",
  type: "document",
  liveEdit: true,
  fields: [
    defineField({
      name: "orderId",
      title: "Order ID",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "status",
      title: "Status",
      type: "string",
      options: {
        list: [
          { title: "Pending", value: "pending" },
          { title: "Paid", value: "paid" },
          { title: "Verification failed", value: "verification_failed" },
          { title: "Cancelled", value: "cancelled" },
          { title: "Refunded", value: "refunded" },
        ],
        layout: "radio",
      },
      initialValue: "pending",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "checkoutToken",
      title: "Checkout Token",
      type: "string",
      readOnly: true,
    }),
    defineField({
      name: "secretToken",
      title: "Secret Token",
      type: "string",
      readOnly: true,
    }),
    defineField({
      name: "helcimInvoiceId",
      title: "Helcim Invoice ID",
      type: "number",
      readOnly: true,
    }),
    defineField({
      name: "helcimInvoiceNumber",
      title: "Helcim Invoice Number",
      type: "string",
      readOnly: true,
    }),
    defineField({
      name: "helcimTransactionId",
      title: "Helcim Transaction ID",
      type: "string",
      readOnly: true,
    }),
    defineField({
      name: "customerName",
      title: "Customer Name",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "customerEmail",
      title: "Customer Email",
      type: "string",
      validation: (Rule) => Rule.required().email(),
    }),
    defineField({
      name: "amount",
      title: "Amount",
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
      name: "lineItems",
      title: "Line Items",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
            defineField({
              name: "sku",
              title: "SKU",
              type: "string",
              validation: (Rule) => Rule.required(),
            }),
            defineField({
              name: "description",
              title: "Description",
              type: "string",
              validation: (Rule) => Rule.required(),
            }),
            defineField({
              name: "quantity",
              title: "Quantity",
              type: "number",
              validation: (Rule) => Rule.required().integer().min(1),
            }),
            defineField({
              name: "price",
              title: "Price",
              type: "number",
              validation: (Rule) => Rule.required().min(0),
            }),
            defineField({
              name: "total",
              title: "Total",
              type: "number",
              validation: (Rule) => Rule.required().min(0),
            }),
          ],
          preview: {
            select: {
              title: "description",
              subtitle: "sku",
            },
          },
        },
      ],
      validation: (Rule) => Rule.required().min(1),
    }),
  ],
  preview: {
    select: {
      title: "orderId",
      subtitle: "status",
    },
  },
});
