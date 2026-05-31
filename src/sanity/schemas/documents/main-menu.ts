import { defineField, defineType } from "sanity";

export const mainMenu = defineType({
  name: "mainMenu",
  title: "Navigation Menu",
  type: "document",
  groups: [
    { name: "navigation", title: "Navigation" },
  ],
  fields: [
    defineField({
      name: "items",
      title: "Menu Items",
      type: "array",
      group: "navigation",
      of: [{ type: "menuDirectLink" }, { type: "menuDropdown" }],
    }),
  ],
  preview: {
    prepare() {
      return { title: "Navigation Menu" };
    },
  },
});
