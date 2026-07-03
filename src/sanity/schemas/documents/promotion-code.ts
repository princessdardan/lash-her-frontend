import { TagIcon } from "@sanity/icons";
import { defineArrayMember, defineField, defineType } from "sanity";

const PROMOTION_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

function normalizeCode(value: string | undefined): string | undefined {
  return value?.trim().toUpperCase().replace(/\s+/g, "");
}

export const promotionCode = defineType({
  name: "promotionCode",
  title: "Promotion Code",
  type: "document",
  icon: TagIcon,
  groups: [
    { name: "overview", title: "Overview" },
    { name: "discount", title: "Discount" },
    { name: "eligibility", title: "Eligibility" },
  ],
  fields: [
    defineField({
      name: "title",
      title: "Internal Title",
      type: "string",
      group: "overview",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "code",
      title: "Code",
      type: "string",
      group: "overview",
      description:
        "Customer-facing checkout code. Use uppercase letters, numbers, dashes, or underscores.",
      validation: (Rule) =>
        Rule.required().custom((value) => {
          const code = normalizeCode(value);
          if (!code) return "Code is required.";
          if (value !== code)
            return "Use the normalized uppercase code without spaces.";
          return (
            PROMOTION_CODE_PATTERN.test(code) ||
            "Use 2-32 uppercase letters, numbers, dashes, or underscores."
          );
        }),
    }),
    defineField({
      name: "isEnabled",
      title: "Enabled",
      type: "boolean",
      group: "overview",
      initialValue: true,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "discountType",
      title: "Discount Type",
      type: "string",
      group: "discount",
      initialValue: "percentage",
      options: {
        layout: "radio",
        list: [
          { title: "Percentage", value: "percentage" },
          { title: "Fixed CAD amount", value: "fixed" },
        ],
      },
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "amount",
      title: "Discount Amount",
      type: "number",
      group: "discount",
      description:
        "Percentage value for percentage discounts, or CAD amount for fixed discounts.",
      validation: (Rule) =>
        Rule.required()
          .min(0.01)
          .custom((value, context) => {
            if (typeof value !== "number")
              return "Discount amount is required.";
            if (
              context.document?.discountType === "percentage" &&
              value > 100
            ) {
              return "Percentage discounts cannot exceed 100%.";
            }
            return true;
          }),
    }),
    defineField({
      name: "appliesTo",
      title: "Applies To",
      type: "string",
      group: "eligibility",
      initialValue: "all",
      options: {
        layout: "radio",
        list: [
          { title: "All products and training programs", value: "all" },
          { title: "All products", value: "products" },
          { title: "All training programs", value: "trainingPrograms" },
          { title: "All services", value: "services" },
          { title: "Specific items", value: "specificItems" },
        ],
      },
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "products",
      title: "Eligible Products",
      type: "array",
      group: "eligibility",
      hidden: ({ document }) => document?.appliesTo !== "specificItems",
      of: [defineArrayMember({ type: "reference", to: [{ type: "product" }] })],
    }),
    defineField({
      name: "trainingPrograms",
      title: "Eligible Training Programs",
      type: "array",
      group: "eligibility",
      hidden: ({ document }) => document?.appliesTo !== "specificItems",
      of: [
        defineArrayMember({
          type: "reference",
          to: [{ type: "trainingProgram" }],
        }),
      ],
    }),
    defineField({
      name: "services",
      title: "Eligible Services",
      type: "array",
      group: "eligibility",
      hidden: ({ document }) => document?.appliesTo !== "specificItems",
      of: [defineArrayMember({ type: "reference", to: [{ type: "service" }] })],
      validation: (Rule) =>
        Rule.custom((value, context) => {
          if (context.document?.appliesTo !== "specificItems") return true;

          const products = context.document?.products;
          const trainingPrograms = context.document?.trainingPrograms;
          const services = value;
          const hasProducts = Array.isArray(products) && products.length > 0;
          const hasTrainingPrograms =
            Array.isArray(trainingPrograms) && trainingPrograms.length > 0;
          const hasServices = Array.isArray(services) && services.length > 0;

          if (!hasProducts && !hasTrainingPrograms && !hasServices) {
            return "Select at least one eligible product, training program, or service.";
          }

          return true;
        }),
    }),
  ],
  preview: {
    select: {
      title: "code",
      amount: "amount",
      discountType: "discountType",
      isEnabled: "isEnabled",
    },
    prepare({ title, amount, discountType, isEnabled }) {
      const amountLabel =
        discountType === "percentage"
          ? `${amount}%`
          : `$${Number(amount).toFixed(2)}`;
      return {
        title,
        subtitle: `${amountLabel}${isEnabled === false ? " · Disabled" : ""}`,
      };
    },
  },
});
