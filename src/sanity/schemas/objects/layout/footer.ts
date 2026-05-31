import { defineArrayMember, defineField, defineType } from "sanity";

const footerNavigationLinkTypes = [
  { title: "Direct Link", value: "direct" },
  { title: "External Link", value: "external" },
];

function validateFooterNavigationUrl(url: string | undefined, linkType: string | undefined) {
  const value = url?.trim();
  if (!value) return true;

  if (linkType === "external") {
    try {
      const parsedUrl = new URL(value);
      return ["http:", "https:"].includes(parsedUrl.protocol)
        ? true
        : "External links must start with http:// or https://.";
    } catch {
      return "External links must start with http:// or https://.";
    }
  }

  if ((value.startsWith("/") && !value.startsWith("//")) || value.startsWith("#")) return true;
  return "Direct links should use a relative path starting with / or #.";
}

export const footer = defineType({
  name: "footer",
  title: "Footer",
  type: "object",
  fields: [
    defineField({
      name: "logoText",
      title: "Logo Text",
      type: "link",
    }),
    defineField({
      name: "text",
      title: "Text",
      type: "string",
    }),
    defineField({
      name: "socialLink",
      title: "Social Links",
      type: "array",
      of: [{ type: "link" }],
    }),
    defineField({
      name: "navigationMenus",
      title: "Navigation Menus",
      type: "array",
      of: [
        defineArrayMember({
          name: "footerNavigationMenu",
          title: "Footer Navigation Menu",
          type: "object",
          fields: [
            defineField({
              name: "heading",
              title: "Heading",
              type: "string",
              description: "Optional group heading shown above this footer menu.",
            }),
            defineField({
              name: "items",
              title: "Menu Items",
              type: "array",
              of: [
                defineArrayMember({
                  name: "footerNavigationItem",
                  title: "Footer Navigation Item",
                  type: "object",
                  fields: [
                    defineField({
                      name: "title",
                      title: "Menu Title",
                      type: "string",
                      validation: (rule) => rule.required(),
                    }),
                    defineField({
                      name: "linkType",
                      title: "Link Type",
                      type: "string",
                      initialValue: "direct",
                      options: {
                        list: footerNavigationLinkTypes,
                        layout: "radio",
                      },
                      validation: (rule) => rule.required(),
                    }),
                    defineField({
                      name: "url",
                      title: "URL",
                      type: "string",
                      validation: (rule) =>
                        rule.required().custom((url, context) => {
                          const parent = context.parent as { linkType?: string } | undefined;
                          return validateFooterNavigationUrl(url, parent?.linkType);
                        }),
                    }),
                  ],
                  preview: {
                    select: {
                      title: "title",
                      subtitle: "url",
                    },
                  },
                }),
              ],
              validation: (rule) => rule.required().min(1),
            }),
          ],
          preview: {
            select: {
              title: "heading",
              items: "items",
            },
            prepare({ title, items }) {
              const itemCount = Array.isArray(items) ? items.length : 0;
              return {
                title: title || "Footer menu",
                subtitle: `${itemCount} menu item${itemCount === 1 ? "" : "s"}`,
              };
            },
          },
        }),
      ],
    }),
  ],
  preview: {
    prepare() {
      return { title: "Footer" };
    },
  },
});
