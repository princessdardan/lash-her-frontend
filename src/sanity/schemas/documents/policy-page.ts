import { DocumentTextIcon } from "@sanity/icons";
import { defineArrayMember, defineField, defineType } from "sanity";

const policyPageTypes = [
  { title: "Privacy Policy", value: "privacy" },
  { title: "Cookie Policy", value: "cookie" },
  { title: "Booking Policy", value: "booking" },
  { title: "Return Policy", value: "return" },
  { title: "Refund Policy", value: "refund" },
  { title: "FAQ", value: "faq" },
  { title: "Terms", value: "terms" },
  { title: "General", value: "general" },
];

const policyPageTypeValues = policyPageTypes.map(({ value }) => value);

function validateSafeHref(value: string | undefined) {
  const href = value?.trim();
  if (!href) return "URL is required.";
  if (href.startsWith("/") && !href.startsWith("//")) return true;
  if (href.startsWith("#")) return true;

  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol)
      ? true
      : "Use a relative path, hash link, or http(s), mailto, or tel URL.";
  } catch {
    return "Use a relative path, hash link, or http(s), mailto, or tel URL.";
  }
}

export const policyPage = defineType({
  name: "policyPage",
  title: "Policy Page",
  type: "document",
  icon: DocumentTextIcon,
  groups: [
    { name: "content", title: "Content" },
    { name: "seo", title: "SEO" },
  ],
  fields: [
    defineField({
      name: "title",
      title: "Title",
      type: "string",
      group: "content",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "slug",
      title: "Slug",
      type: "slug",
      group: "content",
      options: { source: "title" },
      validation: (rule) =>
        rule.required().custom((slug) => {
          const value = slug?.current;
          if (!value) return "Slug is required.";
          return /^[a-z0-9-]+$/.test(value)
            ? true
            : "Use lowercase letters, numbers, and hyphens only.";
        }),
    }),
    defineField({
      name: "pageType",
      title: "Page Type",
      type: "string",
      group: "content",
      options: {
        list: policyPageTypes,
        layout: "radio",
      },
      initialValue: "general",
      validation: (rule) =>
        rule.required().custom((value) =>
          !value || policyPageTypeValues.includes(value)
            ? true
            : "Select a valid policy page type.",
        ),
    }),
    defineField({
      name: "summary",
      title: "Summary",
      type: "text",
      rows: 3,
      group: "content",
      description: "Short intro and metadata fallback.",
    }),
    defineField({
      name: "body",
      title: "Body",
      type: "array",
      group: "content",
      of: [
        defineArrayMember({
          type: "block",
          styles: [
            { title: "Normal", value: "normal" },
            { title: "H2", value: "h2" },
            { title: "H3", value: "h3" },
          ],
          lists: [
            { title: "Bullet", value: "bullet" },
            { title: "Numbered", value: "number" },
          ],
          marks: {
            decorators: [
              { title: "Strong", value: "strong" },
              { title: "Emphasis", value: "em" },
            ],
            annotations: [
              {
                name: "link",
                title: "Link",
                type: "object",
                fields: [
                  defineField({
                    name: "href",
                    title: "URL",
                    type: "string",
                    validation: (rule) => rule.required().custom(validateSafeHref),
                  }),
                  defineField({
                    name: "blank",
                    title: "Open in new tab",
                    type: "boolean",
                    initialValue: false,
                  }),
                ],
              },
            ],
          },
        }),
      ],
      validation: (rule) => rule.required().min(1),
    }),
    defineField({
      name: "seo",
      title: "SEO",
      type: "object",
      group: "seo",
      fields: [
        defineField({
          name: "title",
          title: "SEO Title",
          type: "string",
        }),
        defineField({
          name: "description",
          title: "SEO Description",
          type: "text",
          rows: 3,
        }),
        defineField({
          name: "noIndex",
          title: "Hide from search engines",
          type: "boolean",
          initialValue: false,
        }),
      ],
    }),
  ],
  preview: {
    select: {
      title: "title",
      subtitle: "slug.current",
    },
  },
});
