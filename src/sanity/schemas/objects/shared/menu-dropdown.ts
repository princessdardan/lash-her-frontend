import { defineField, defineType } from "sanity";

export const menuDropdown = defineType({
  name: "menuDropdown",
  title: "Menu Dropdown",
  type: "object",
  fields: [
    defineField({
      name: "title",
      title: "Title",
      type: "string",
    }),
    defineField({
      name: "sections",
      title: "Sections",
      type: "array",
      of: [{ type: "menuDropdownSection" }],
    }),
  ],
  preview: {
    select: {
      title: "title",
    },
  },
});
