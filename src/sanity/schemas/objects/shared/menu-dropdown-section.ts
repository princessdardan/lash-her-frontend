import { defineField, defineType } from "sanity";

export const menuDropdownSection = defineType({
  name: "menuDropdownSection",
  title: "Menu Dropdown Section",
  type: "object",
  fields: [
    defineField({
      name: "heading",
      title: "Heading",
      type: "string",
    }),
    defineField({
      name: "links",
      title: "Links",
      type: "array",
      of: [{ type: "menuLink" }],
    }),
  ],
  preview: {
    select: {
      title: "heading",
    },
  },
});
