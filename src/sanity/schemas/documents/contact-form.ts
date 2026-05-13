import { defineField, defineType } from "sanity";

export const contactForm = defineType({
  name: "contactForm",
  title: "Training Contact Form",
  type: "document",
  liveEdit: true,
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
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "location",
      title: "Location",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "instagram",
      title: "Instagram",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "experience",
      title: "Experience",
      type: "string",
      validation: (Rule) => Rule.required(),
      options: {
        list: [
          {
            title: "Beginner - New to Lashes",
            value: "Beginner - New to Lashes",
          },
          {
            title: "Advanced - Have Experience",
            value: "Advanced - Have Experience",
          },
        ],
      },
    }),
    defineField({
      name: "interest",
      title: "Interest",
      type: "string",
      validation: (Rule) => Rule.required(),
      options: {
        list: [
          { title: "Lash Designer Academy", value: "Lash Designer Academy" },
          {
            title: "Beginner Private Training",
            value: "Beginner Private Training",
          },
          {
            title: "Beginner Group Training",
            value: "Beginner Group Training",
          },
          {
            title: "Advanced Private Training",
            value: "Advanced Private Training",
          },
          { title: "Not Sure Yet", value: "Not Sure Yet" },
        ],
      },
    }),
    defineField({
      name: "clients",
      title: "Clients",
      type: "number",
      validation: (Rule) => Rule.min(0),
    }),
    defineField({
      name: "info",
      title: "Additional Info",
      type: "text",
    }),
  ],
  preview: {
    select: {
      title: "name",
      subtitle: "interest",
    },
  },
});
