import { defineArrayMember, defineField, defineType } from "sanity";
import { validateLandingPageSlug } from "@/lib/landing-pages/contract";

export const landingPage = defineType({
  name: "landingPage",
  title: "Landing Page",
  type: "document",
  groups: [
    { name: "content", title: "Content", default: true },
    { name: "signup", title: "Email Signup" },
    { name: "seo", title: "SEO" },
  ],
  initialValue: {
    signup: {
      heading: "Be the first to know",
      description: "Join our email list for updates and announcements.",
      submitLabel: "Join the list",
      successMessage: "You're on the list. Watch your inbox for updates.",
    },
  },
  fields: [
    defineField({
      name: "title",
      title: "Page Title",
      type: "string",
      group: "content",
      description:
        "Used in Studio and as the default search and sharing title.",
      validation: (rule) => rule.required().max(160),
    }),
    defineField({
      name: "slug",
      title: "URL Slug",
      type: "slug",
      group: "content",
      description:
        "The page address is /your-slug. Generate from the title or edit it directly. Changing a published slug changes its URL; old links will no longer work.",
      options: { source: "title", maxLength: 96 },
      validation: (rule) =>
        rule
          .required()
          .custom((value) => validateLandingPageSlug(value?.current)),
    }),
    defineField({
      name: "eyebrow",
      title: "Eyebrow",
      type: "string",
      group: "content",
      validation: (rule) => rule.max(100),
    }),
    defineField({
      name: "heading",
      title: "Headline",
      type: "string",
      group: "content",
      validation: (rule) => rule.required().max(200),
    }),
    defineField({
      name: "description",
      title: "Introduction",
      type: "text",
      rows: 4,
      group: "content",
      validation: (rule) => rule.required().max(1000),
    }),
    defineField({
      name: "heroImage",
      title: "Image",
      type: "image",
      group: "content",
      options: { hotspot: true },
      fields: [
        defineField({
          name: "alt",
          title: "Alternative Text",
          type: "string",
          validation: (rule) => rule.required(),
        }),
      ],
    }),
    defineField({
      name: "body",
      title: "Additional Details",
      type: "array",
      group: "content",
      description:
        "Optional benefits, opening details, and membership information below the introduction.",
      of: [
        defineArrayMember({
          type: "block",
          styles: [
            { title: "Normal", value: "normal" },
            { title: "Heading", value: "h2" },
            { title: "Subheading", value: "h3" },
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
            annotations: [],
          },
        }),
      ],
    }),
    defineField({
      name: "signup",
      title: "Email Signup",
      type: "object",
      group: "signup",
      description:
        "Collects email signups with explicit consent. This records interest; it does not sell or activate a membership. Signup records are stored privately, not in Studio.",
      fields: [
        defineField({
          name: "heading",
          title: "Form Heading",
          type: "string",
          validation: (rule) => rule.required().max(160),
        }),
        defineField({
          name: "description",
          title: "Form Description",
          type: "text",
          rows: 3,
          validation: (rule) => rule.max(500),
        }),
        defineField({
          name: "submitLabel",
          title: "Button Label",
          type: "string",
          validation: (rule) => rule.required().max(80),
        }),
        defineField({
          name: "successMessage",
          title: "Success Message",
          type: "text",
          rows: 3,
          validation: (rule) => rule.required().max(500),
        }),
        defineField({
          name: "privacyPolicy",
          title: "Privacy Policy",
          type: "reference",
          to: [{ type: "policyPage" }],
          options: { filter: 'pageType == "privacy"' },
          description:
            "Select the privacy policy to link below the signup form.",
        }),
      ],
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "seo",
      title: "Search and Sharing",
      type: "object",
      group: "seo",
      fields: [
        defineField({
          name: "title",
          title: "SEO Title",
          type: "string",
          validation: (rule) => rule.max(160),
        }),
        defineField({
          name: "description",
          title: "SEO Description",
          type: "text",
          rows: 3,
          validation: (rule) => rule.max(320),
        }),
        defineField({
          name: "noIndex",
          title: "Hide from Search Engines",
          type: "boolean",
          initialValue: false,
        }),
      ],
    }),
  ],
  preview: {
    select: { title: "title", slug: "slug.current", media: "heroImage" },
    prepare: ({ title, slug, media }) => ({
      title,
      subtitle: slug ? `/${slug}` : "Set a URL slug",
      media,
    }),
  },
});
