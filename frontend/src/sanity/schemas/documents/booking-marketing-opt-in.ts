import { EnvelopeIcon } from "@sanity/icons";
import { defineArrayMember, defineField, defineType } from "sanity";

export const bookingMarketingOptIn = defineType({
  name: "bookingMarketingOptIn",
  title: "Booking Marketing Opt-in",
  type: "document",
  icon: EnvelopeIcon,
  fields: [
    defineField({
      name: "name",
      title: "Name",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "email",
      title: "Email",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "phone",
      title: "Phone",
      type: "string",
    }),
    defineField({
      name: "bookingType",
      title: "Booking Type",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "answers",
      title: "Answers",
      type: "array",
      of: [
        defineArrayMember({
          name: "answer",
          title: "Answer",
          type: "object",
          fields: [
            defineField({
              name: "questionId",
              title: "Question ID",
              type: "string",
              validation: (Rule) => Rule.required(),
            }),
            defineField({
              name: "questionLabel",
              title: "Question Label",
              type: "string",
              validation: (Rule) => Rule.required(),
            }),
            defineField({
              name: "answer",
              title: "Answer",
              type: "text",
              validation: (Rule) => Rule.required(),
            }),
          ],
        }),
      ],
    }),
  ],
  preview: {
    select: {
      title: "name",
      subtitle: "email",
    },
  },
});
