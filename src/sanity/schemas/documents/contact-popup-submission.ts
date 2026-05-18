import { defineField, defineType } from "sanity";

export const contactPopupSubmission = defineType({
  name: "contactPopupSubmission",
  title: "Contact Popup Submission",
  type: "document",
  fields: [
    defineField({
      name: "variant",
      title: "Variant",
      type: "string",
      options: {
        list: [
          { title: "Full Contact", value: "fullContact" },
          { title: "Email Only", value: "emailOnly" },
        ],
      },
    }),
    defineField({
      name: "name",
      title: "Name",
      type: "string",
    }),
    defineField({
      name: "email",
      title: "Email",
      type: "string",
      validation: (Rule) => Rule.required().email(),
    }),
    defineField({
      name: "instagram",
      title: "Instagram",
      type: "string",
    }),
    defineField({
      name: "sourcePath",
      title: "Source Path",
      type: "string",
      description: "The page where the popup was submitted",
    }),
  ],
  preview: {
    select: {
      title: "email",
      subtitle: "name",
    },
  },
});
