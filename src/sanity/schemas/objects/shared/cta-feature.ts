import { defineField, defineType } from "sanity";

export const ctaFeature = defineType({
  name: "ctaFeature",
  title: "CTA Feature",
  type: "object",
  fields: [
    defineField({
      name: "heading",
      title: "Heading",
      type: "string",
    }),
    defineField({
      name: "subHeading",
      title: "Sub Heading",
      type: "string",
    }),
    defineField({
      name: "location",
      title: "Location",
      type: "string",
    }),
    defineField({
      name: "tier",
      title: "Tier",
      type: "string",
    }),
    defineField({
      name: "features",
      title: "Features",
      type: "array",
      of: [
        {
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
                type: "object",
                title: "Link",
                fields: [
                  { name: "href", type: "string", title: "URL" },
                  { name: "blank", type: "boolean", title: "Open in new tab" },
                ],
              },
            ],
          },
        },
      ],
    }),
    defineField({
      name: "link",
      title: "Link",
      type: "link",
    }),
    defineField({
      name: "icon",
      title: "Icon",
      type: "string",
      options: {
        list: [
          { title: "Video Icon", value: "VIDEO_ICON" },
          { title: "User Icon", value: "USER_ICON" },
          { title: "Users Icon", value: "USERS_ICON" },
          { title: "Award Icon", value: "AWARD_ICON" },
        ],
      },
    }),
    defineField({
      name: "mostPopular",
      title: "Most Popular",
      type: "boolean",
    }),
  ],
  preview: {
    select: {
      title: "heading",
      subtitle: "tier",
    },
  },
});
