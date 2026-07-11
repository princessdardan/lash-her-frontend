import { defineField, defineType, defineArrayMember } from "sanity";

function validateSafeHref(value: string | undefined) {
  if (!value) return true;
  if (value.startsWith("#")) return true;
  if (value.startsWith("https://")) return true;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  return 'URL must start with "#", "https://", or "/" (but not "//").';
}

function validateGoogleAppointmentScheduleUrl(value: string | undefined) {
  if (!value) return true;

  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      url.hostname === "calendar.google.com" &&
      url.pathname.startsWith("/calendar/appointments/schedules/")
    ) {
      return true;
    }
  } catch {
    return "Enter a valid Google Appointment Schedule URL.";
  }

  return "Use the public Google Appointment Schedule URL from calendar.google.com/calendar/appointments/schedules/.";
}

export const trainingProgram = defineType({
  name: "trainingProgram",
  title: "Training Program",
  type: "document",
  fields: [
    defineField({
      name: "slug",
      title: "Slug",
      type: "slug",
      group: "overview",
      options: {
        source: "title",
      },
    }),
    defineField({
      name: "title",
      title: "Title",
      type: "string",
      group: "overview",
    }),
    defineField({
      name: "description",
      title: "Description",
      type: "text",
      group: "overview",
    }),
    defineField({
      name: "heroSubtitle",
      title: "Hero Subtitle",
      type: "string",
      group: "overview",
    }),
    defineField({
      name: "heroImage",
      title: "Hero Image",
      type: "image",
      group: "overview",
      options: { hotspot: true },
      fields: [defineField({ name: "alt", title: "Alt text", type: "string" })],
    }),
    defineField({
      name: "heroBadges",
      title: "Hero Badges",
      type: "array",
      group: "overview",
      of: [defineArrayMember({ type: "string" })],
    }),
    defineField({
      name: "displayOrder",
      title: "Display Order",
      type: "number",
      group: "overview",
      initialValue: 0,
      validation: (Rule) => Rule.integer(),
    }),
    defineField({
      name: "image",
      title: "Catalog Image",
      type: "image",
      group: "overview",
      options: { hotspot: true },
      fields: [defineField({ name: "alt", title: "Alt text", type: "string" })],
    }),
    defineField({
      name: "detailEyebrow",
      title: "Detail Eyebrow",
      type: "string",
      group: "curriculum",
    }),
    defineField({
      name: "detailHeading",
      title: "Detail Section Heading",
      type: "string",
      group: "curriculum",
    }),
    defineField({
      name: "detailDescription",
      title: "Detail Section Description",
      type: "text",
      group: "curriculum",
    }),
    defineField({
      name: "detailItems",
      title: "Detail Items",
      type: "array",
      group: "curriculum",
      of: [
        defineArrayMember({
          type: "object",
          fields: [
            defineField({
              name: "eyelash",
              title: "Eyelash Label",
              type: "string",
            }),
            defineField({ name: "title", title: "Title", type: "string" }),
            defineField({
              name: "description",
              title: "Description",
              type: "array",
              of: [
                defineArrayMember({
                  type: "block",
                  styles: [{ title: "Normal", value: "normal" }],
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
          ],
        }),
      ],
    }),
    defineField({
      name: "factList",
      title: "Fact List",
      type: "array",
      group: "curriculum",
      of: [defineArrayMember({ type: "string" })],
    }),
    defineField({
      name: "primaryCta",
      title: "Primary CTA",
      type: "object",
      group: "enrollment",
      fields: [
        defineField({ name: "label", title: "Label", type: "string" }),
        defineField({
          name: "href",
          title: "URL",
          type: "string",
          validation: (Rule) => Rule.custom(validateSafeHref),
        }),
      ],
    }),
    defineField({
      name: "secondaryCta",
      title: "Secondary CTA",
      type: "object",
      group: "enrollment",
      fields: [
        defineField({ name: "label", title: "Label", type: "string" }),
        defineField({
          name: "href",
          title: "URL",
          type: "string",
          validation: (Rule) => Rule.custom(validateSafeHref),
        }),
      ],
    }),
    defineField({
      name: "enrollmentTitle",
      title: "Enrollment Title",
      type: "string",
      group: "enrollment",
    }),
    defineField({
      name: "enrollmentDescription",
      title: "Enrollment Description",
      type: "text",
      group: "enrollment",
    }),
    defineField({
      name: "enrollmentBackgroundImage",
      title: "Enrollment Background Image",
      type: "image",
      group: "enrollment",
      options: { hotspot: true },
      fields: [defineField({ name: "alt", title: "Alt text", type: "string" })],
    }),
    defineField({
      name: "trainingContact",
      title: "Training Contact Section",
      type: "trainingContactSection",
      group: "enrollment",
      description:
        "Structured contact section rendered at #contact on the training detail page.",
    }),
    defineField({
      name: "checkoutEnabled",
      title: "Enable Online Checkout",
      type: "boolean",
      group: "checkout",
      initialValue: false,
    }),
    defineField({
      name: "price",
      title: "Price",
      type: "number",
      group: "checkout",
      hidden: ({ document }) => !document?.checkoutEnabled,
      validation: (Rule) =>
        Rule.custom((value, context) => {
          if (!context.document?.checkoutEnabled) return true;
          if (typeof value === "number" && Number.isFinite(value) && value > 0)
            return true;
          return "Training checkout requires a positive native price.";
        }),
    }),
    defineField({
      name: "discountPrice",
      title: "Manual Discount Price",
      type: "number",
      group: "checkout",
      hidden: ({ document }) => !document?.checkoutEnabled,
      description:
        "Optional sale price configured directly in Sanity. Must be lower than the regular training price.",
      validation: (Rule) =>
        Rule.min(0).custom((value, context) => {
          if (!context.document?.checkoutEnabled || value === undefined)
            return true;
          return typeof context.document.price === "number" &&
            value < context.document.price
            ? true
            : "Manual discount price must be lower than the regular training price.";
        }),
    }),
    defineField({
      name: "isAvailable",
      title: "Available for checkout",
      type: "boolean",
      group: "checkout",
      initialValue: true,
      hidden: ({ document }) => !document?.checkoutEnabled,
      validation: (Rule) =>
        Rule.custom((value, context) => {
          if (!context.document?.checkoutEnabled) return true;
          return typeof value === "boolean"
            ? true
            : "Set whether this training program is available for checkout.";
        }),
    }),
    defineField({
      name: "availabilityLabel",
      title: "Availability Label",
      type: "string",
      group: "checkout",
      hidden: ({ document }) => !document?.checkoutEnabled,
      description: "e.g., 'Now enrolling', 'Waitlist', or 'Limited seats'.",
    }),
    defineField({
      name: "fulfillmentNote",
      title: "Fulfillment Note",
      type: "text",
      group: "checkout",
      hidden: ({ document }) => !document?.checkoutEnabled,
      description: "Enrollment or next-step details shown around checkout.",
    }),
    defineField({
      name: "checkoutCtaLabel",
      title: "Checkout CTA Label",
      type: "string",
      group: "checkout",
      initialValue: "Enroll Now",
      hidden: ({ document }) => !document?.checkoutEnabled,
    }),
    defineField({
      name: "checkoutDisabledBookingCta",
      title: "Disabled Checkout Booking CTA",
      type: "object",
      group: "checkout",
      hidden: ({ document }) => !!document?.checkoutEnabled,
      fields: [
        defineField({
          name: "label",
          title: "Label",
          type: "string",
          initialValue: "Book a Call",
        }),
        defineField({
          name: "href",
          title: "URL",
          type: "string",
          initialValue: "#contact",
          validation: (Rule) =>
            Rule.custom((value) => {
              return validateSafeHref(value);
            }),
        }),
      ],
    }),
    defineField({
      name: "postPurchaseInstructions",
      title: "Post-Purchase Instructions",
      type: "text",
      group: "checkout",
      hidden: ({ document }) => !document?.checkoutEnabled,
    }),
    defineField({
      name: "introCallAppointmentScheduleUrl",
      title: "Intro Call Appointment Schedule URL",
      type: "url",
      group: "checkout",
      hidden: ({ document }) => !document?.checkoutEnabled,
      description:
        "Public Google Calendar Appointment Schedule URL shown only after a paid training scheduling token is verified.",
      validation: (Rule) => Rule.custom(validateGoogleAppointmentScheduleUrl),
    }),
    defineField({
      name: "introCallAppointmentScheduleEmbedMode",
      title: "Intro Call Appointment Schedule Display",
      type: "string",
      group: "checkout",
      hidden: ({ document }) => !document?.checkoutEnabled,
      description:
        "Choose whether verified students see an embedded scheduler or a button to open the Google Appointment Schedule.",
      initialValue: "link",
      options: {
        layout: "radio",
        list: [
          { title: "Open as link", value: "link" },
          { title: "Embed on page", value: "embed" },
        ],
      },
      validation: (Rule) =>
        Rule.custom((value) => {
          if (value === undefined || value === "link" || value === "embed")
            return true;
          return "Choose link or embed display mode.";
        }),
    }),
    defineField({
      name: "introCallSchedulingInstructions",
      title: "Intro Call Scheduling Instructions",
      type: "text",
      group: "checkout",
      hidden: ({ document }) => !document?.checkoutEnabled,
      description:
        "Optional public guidance shown above the Google Appointment Schedule after paid token verification.",
    }),
    defineField({
      name: "blocks",
      title: "Blocks",
      type: "array",
      group: "legacy",
      deprecated: {
        reason:
          "Training detail contact forms now use the Training Contact Section field.",
      },
      readOnly: true,
      hidden: ({ value }) => value === undefined,
      of: [{ type: "contactFormLabels" }],
    }),
    defineField({
      name: "seo",
      title: "SEO",
      type: "object",
      group: "seo",
      fields: [
        defineField({ name: "title", title: "SEO Title", type: "string" }),
        defineField({
          name: "description",
          title: "SEO Description",
          type: "text",
        }),
        defineField({
          name: "image",
          title: "SEO Image",
          type: "image",
          options: { hotspot: true },
        }),
      ],
    }),
  ],
  groups: [
    { name: "overview", title: "Overview" },
    { name: "curriculum", title: "Curriculum" },
    { name: "enrollment", title: "Enrollment" },
    { name: "checkout", title: "Checkout" },
    { name: "legacy", title: "Legacy Blocks" },
    { name: "seo", title: "SEO" },
  ],
  preview: {
    select: {
      title: "title",
      subtitle: "slug.current",
    },
  },
});
