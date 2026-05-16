import { defineField, defineType } from "sanity";

export const link = defineType({
  name: "link",
  title: "Link",
  type: "object",
  fields: [
    defineField({
      name: "href",
      title: "URL",
      type: "string",
      validation: (rule) =>
        rule.custom((href) => {
          const value = href?.trim();
          if (!value) return true;
          if (value.startsWith("/") && !value.startsWith("//")) return true;
          if (value.startsWith("#")) return true;

          try {
            const url = new URL(value);
            return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol)
              ? true
              : "Use a relative path, hash link, or http(s), mailto, or tel URL.";
          } catch {
            return "Use a relative path, hash link, or http(s), mailto, or tel URL.";
          }
        }),
    }),
    defineField({
      name: "label",
      title: "Label",
      type: "string",
    }),
    defineField({
      name: "isExternal",
      title: "Open in new tab",
      type: "boolean",
      initialValue: false,
    }),
  ],
  preview: {
    select: {
      title: "label",
      subtitle: "href",
    },
  },
});
