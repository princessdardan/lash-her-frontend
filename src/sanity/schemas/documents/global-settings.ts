import { defineField, defineType } from "sanity";

export const globalSettings = defineType({
  name: "globalSettings",
  title: "Global Settings",
  type: "document",
  groups: [
    { name: "site", title: "Site" },
    { name: "media", title: "Media" },
    { name: "navigation", title: "Navigation" },
    { name: "forms", title: "Forms" },
  ],
  fields: [
    defineField({
      name: "title",
      title: "Title",
      type: "string",
      group: "site",
    }),
    defineField({
      name: "description",
      title: "Description",
      type: "text",
      group: "site",
    }),
    defineField({
      name: "ogImage",
      title: "Open Graph Image",
      type: "image",
      group: "media",
      description: "Default social sharing image (recommended: 1200 x 630px)",
      options: { hotspot: false },
    }),
    defineField({
      name: "header",
      title: "Header",
      type: "header",
      group: "navigation",
    }),
    defineField({
      name: "footer",
      title: "Footer",
      type: "footer",
      group: "navigation",
    }),
    defineField({
      name: "contactPopup",
      title: "Contact Popup",
      type: "object",
      group: "forms",
      fields: [
        defineField({
          name: "enabled",
          title: "Enabled",
          type: "boolean",
          initialValue: false,
        }),
        defineField({
          name: "variant",
          title: "Variant",
          type: "string",
          options: {
            list: [
              { title: "Full Contact (Name, Email, Instagram)", value: "fullContact" },
              { title: "Email Only", value: "emailOnly" },
            ],
          },
          initialValue: "fullContact",
        }),
        defineField({
          name: "heading",
          title: "Heading",
          type: "string",
        }),
        defineField({
          name: "description",
          title: "Description",
          type: "text",
        }),
        defineField({
          name: "privacyText",
          title: "Privacy Agreement Text",
          type: "string",
        }),
        defineField({
          name: "privacyLinkLabel",
          title: "Privacy Link Label",
          type: "string",
        }),
        defineField({
          name: "privacyLinkHref",
          title: "Privacy Link URL",
          type: "string",
        }),
        defineField({
          name: "submitLabel",
          title: "Submit Button Label",
          type: "string",
        }),
        defineField({
          name: "successMessage",
          title: "Success Message",
          type: "string",
        }),
        defineField({
          name: "cookieExpiryDays",
          title: "Cookie Expiry (Days)",
          type: "number",
          initialValue: 30,
          description: "How many days before the popup shows again after being dismissed or submitted.",
        }),
      ],
    }),
  ],
  preview: {
    select: {
      title: "title",
    },
  },
});
