import { CalendarIcon } from "@sanity/icons";
import { defineArrayMember, defineField, defineType } from "sanity";

export const BOOKING_TYPE_OPTIONS = [
  { title: "Training Call", value: "training-call" },
  { title: "In-person Appointment", value: "in-person-appointment" },
];

export const bookingSettings = defineType({
  name: "bookingSettings",
  title: "Booking Settings",
  type: "document",
  icon: CalendarIcon,
  fields: [
    defineField({
      name: "calendarId",
      title: "Calendar ID",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "availabilityMarkerTitle",
      title: "Availability Marker Title",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "bookingHorizonDays",
      title: "Booking Horizon Days",
      type: "number",
      validation: (Rule) => Rule.required().integer().min(1),
    }),
    defineField({
      name: "minimumLeadTimeHours",
      title: "Minimum Lead Time Hours",
      type: "number",
      validation: (Rule) => Rule.required().integer().min(0),
    }),
    defineField({
      name: "timezone",
      title: "Timezone",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "bookingTypes",
      title: "Booking Types",
      type: "array",
      of: [
        defineArrayMember({
          name: "bookingType",
          title: "Booking Type",
          type: "object",
          fields: [
            defineField({
              name: "type",
              title: "Type",
              type: "string",
              options: { list: BOOKING_TYPE_OPTIONS },
              validation: (Rule) => Rule.required(),
            }),
            defineField({
              name: "label",
              title: "Label",
              type: "string",
              validation: (Rule) => Rule.required(),
            }),
            defineField({
              name: "description",
              title: "Description",
              type: "text",
            }),
            defineField({
              name: "durationMinutes",
              title: "Duration Minutes",
              type: "number",
              validation: (Rule) => Rule.required().integer().min(1),
            }),
            defineField({
              name: "slotIntervalMinutes",
              title: "Slot Interval Minutes",
              type: "number",
              validation: (Rule) => Rule.required().integer().min(1),
            }),
            defineField({
              name: "bufferBeforeMinutes",
              title: "Buffer Before Minutes",
              type: "number",
              validation: (Rule) => Rule.required().integer().min(0),
            }),
            defineField({
              name: "bufferAfterMinutes",
              title: "Buffer After Minutes",
              type: "number",
              validation: (Rule) => Rule.required().integer().min(0),
            }),
            defineField({
              name: "questions",
              title: "Questions",
              type: "array",
              of: [
                defineArrayMember({
                  name: "question",
                  title: "Question",
                  type: "object",
                  fields: [
                    defineField({
                      name: "id",
                      title: "ID",
                      type: "string",
                      validation: (Rule) => Rule.required(),
                    }),
                    defineField({
                      name: "label",
                      title: "Label",
                      type: "string",
                      validation: (Rule) => Rule.required(),
                    }),
                    defineField({
                      name: "inputType",
                      title: "Input Type",
                      type: "string",
                      options: {
                        list: [
                          { title: "Text", value: "text" },
                          { title: "Textarea", value: "textarea" },
                          { title: "Select", value: "select" },
                        ],
                      },
                      validation: (Rule) => Rule.required(),
                    }),
                    defineField({
                      name: "required",
                      title: "Required",
                      type: "boolean",
                    }),
                    defineField({
                      name: "options",
                      title: "Options",
                      type: "array",
                      of: [defineArrayMember({ type: "string" })],
                      hidden: ({ parent }) => parent?.inputType !== "select",
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
      validation: (Rule) => Rule.required().min(1),
    }),
    defineField({
      name: "marketingOptInLabel",
      title: "Marketing Opt-in Label",
      type: "text",
      validation: (Rule) => Rule.required(),
    }),
  ],
  preview: {
    prepare() {
      return { title: "Booking Settings" };
    },
  },
});
