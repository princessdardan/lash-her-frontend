import { EnvelopeIcon } from "@sanity/icons";
import { defineField, defineType, defineArrayMember } from "sanity";

export const trainingContactSection = defineType({
  name: "trainingContactSection",
  title: "Training Contact Section",
  type: "object",
  icon: EnvelopeIcon,
  fields: [
    defineField({
      name: "enabled",
      title: "Show contact section",
      type: "boolean",
      initialValue: true,
    }),
    defineField({
      name: "heading",
      title: "Heading",
      type: "string",
      initialValue: "Begin Your Training Conversation",
      validation: (rule) => rule.max(120),
    }),
    defineField({
      name: "subHeading",
      title: "Subheading",
      type: "text",
      rows: 3,
      initialValue: "Share your details and we will follow up with next steps for this training program.",
      validation: (rule) => rule.max(240),
    }),
    defineField({
      name: "name",
      title: "Name field label",
      type: "string",
      initialValue: "Name",
    }),
    defineField({
      name: "email",
      title: "Email field label",
      type: "string",
      initialValue: "Email",
    }),
    defineField({
      name: "phone",
      title: "Phone field label",
      type: "string",
      initialValue: "Phone Number",
    }),
    defineField({
      name: "location",
      title: "Location field label",
      type: "string",
      initialValue: "Location (optional)",
    }),
    defineField({
      name: "instagram",
      title: "Instagram field label",
      type: "string",
      initialValue: "Instagram (optional)",
    }),
    defineField({
      name: "submitLabel",
      title: "Submit button label",
      type: "string",
      initialValue: "Submit Training Inquiry",
    }),
    defineField({
      name: "successMessage",
      title: "Success message",
      type: "string",
      initialValue: "Thank you. Your training inquiry has been received.",
    }),
    defineField({
      name: "privacyPolicyText",
      title: "Privacy Policy Text",
      type: "array",
      of: [
        defineArrayMember({
          type: "block",
          styles: [{ title: "Normal", value: "normal" }],
          lists: [],
          marks: {
            decorators: [
              { title: "Strong", value: "strong" },
              { title: "Emphasis", value: "em" },
            ],
            annotations: [
              {
                name: "link",
                type: "object",
                title: "Link",
                fields: [
                  defineField({
                    name: "href",
                    type: "url",
                    title: "URL",
                    validation: (Rule) =>
                      Rule.required().uri({
                        allowRelative: true,
                        scheme: ["https", "http", "mailto", "tel"],
                      }),
                  }),
                  defineField({
                    name: "blank",
                    type: "boolean",
                    title: "Open in new tab",
                    initialValue: true,
                  }),
                ],
              },
            ],
          },
        }),
      ],
      description:
        "Text displayed before the privacy policy checkbox. Supports links (e.g. to /privacy-policy).",
    }),
  ],
  preview: {
    select: {
      title: "heading",
      subtitle: "subHeading",
    },
    prepare({ title, subtitle }) {
      return {
        title: title || "Training Contact Section",
        subtitle,
      };
    },
  },
});
