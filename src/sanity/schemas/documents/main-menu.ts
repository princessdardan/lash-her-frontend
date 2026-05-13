import { defineField, defineType } from "sanity";

export const mainMenu = defineType({
  name: "mainMenu",
  title: "Navigation Menu",
  type: "document",
  fields: [
    defineField({
      name: "items",
      title: "Menu Items",
      type: "array",
      of: [{ type: "menuDirectLink" }, { type: "menuDropdown" }],
    }),
  ],
  preview: {
    prepare() {
      return { title: "Navigation Menu" };
    },
  },
});
