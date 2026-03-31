import { defineField, defineType } from "sanity";

export const imageWithText = defineType({
  name: "imageWithText",
  title: "Image with Text",
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
      name: "description",
      title: "Description",
      type: "string",
    }),
    defineField({
      name: "perks",
      title: "Perks",
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
      name: "image",
      title: "Image",
      type: "image",
      options: { hotspot: true },
      fields: [
        defineField({
          name: "alt",
          title: "Alternative Text",
          type: "string",
        }),
      ],
    }),
    defineField({
      name: "orientation",
      title: "Orientation",
      type: "string",
      options: {
        list: [
          { title: "Image Left", value: "HORIZONTAL_IMAGE_LEFT" },
          { title: "Image Right", value: "HORIZONTAL_IMAGE_RIGHT" },
          { title: "Vertical", value: "VERTICAL" },
        ],
      },
    }),
  ],
  preview: {
    select: {
      title: "heading",
    },
  },
});
