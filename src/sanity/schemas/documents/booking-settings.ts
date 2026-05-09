import { CalendarIcon } from "@sanity/icons";
import { defineArrayMember, defineField, defineType } from "sanity";

export const BOOKING_TYPE_OPTIONS = [
  { title: "Training sign-up call", value: "training-call" },
  { title: "In-person appointment", value: "in-person-appointment" },
];

export const bookingSettings = defineType({
  name: "bookingSettings",
  title: "Booking Settings",
  type: "document",
  icon: CalendarIcon,
  fields: [
    defineField({
      name: "calendarId",
      title: "Google Calendar ID",
      type: "string",
      description:
        "Use primary for the connected Gmail primary calendar, or a specific Google Calendar ID.",
      initialValue: "primary",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "availabilityMarkerTitle",
      title: "Availability Marker Title",
      type: "string",
      initialValue: "Available for booking",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "bookingHorizonDays",
      title: "Booking Horizon Days",
      type: "number",
      initialValue: 30,
      validation: (Rule) => Rule.required().integer().min(1).max(180),
    }),
    defineField({
      name: "minimumLeadTimeHours",
      title: "Minimum Lead Time Hours",
      type: "number",
      initialValue: 24,
      validation: (Rule) => Rule.required().integer().min(0).max(720),
    }),
    defineField({
      name: "timezone",
      title: "Booking Timezone",
      type: "string",
      initialValue: "America/Toronto",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "bookingTypes",
      title: "Booking Types",
      type: "array",
      of: [
        defineArrayMember({
          name: "bookingTypeConfig",
          title: "Booking Type",
          type: "object",
          fields: [
            defineField({
              name: "type",
              title: "Type",
              type: "string",
              options: { list: BOOKING_TYPE_OPTIONS, layout: "radio" },
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
              rows: 3,
              validation: (Rule) => Rule.required(),
            }),
            defineField({
              name: "durationMinutes",
              title: "Duration Minutes",
              type: "number",
              validation: (Rule) => Rule.required().integer().min(15).max(60),
            }),
            defineField({
              name: "slotIntervalMinutes",
              title: "Slot Interval Minutes",
              type: "number",
              validation: (Rule) => Rule.required().integer().min(5).max(60),
            }),
            defineField({
              name: "bufferBeforeMinutes",
              title: "Buffer Before Minutes",
              type: "number",
              initialValue: 0,
              validation: (Rule) => Rule.required().integer().min(0).max(60),
            }),
            defineField({
              name: "bufferAfterMinutes",
              title: "Buffer After Minutes",
              type: "number",
              initialValue: 0,
              validation: (Rule) => Rule.required().integer().min(0).max(60),
            }),
            defineField({
              name: "questions",
              title: "Type-specific Questions",
              type: "array",
              of: [
                defineArrayMember({
                  name: "bookingQuestion",
                  title: "Question",
                  type: "object",
                  fields: [
                    defineField({
                      name: "id",
                      title: "ID",
                      type: "string",
                      validation: (Rule) => Rule.required().regex(/^[a-z0-9-]+$/),
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
                        list: ["text", "textarea", "select"],
                        layout: "radio",
                      },
                      validation: (Rule) => Rule.required(),
                    }),
                    defineField({
                      name: "required",
                      title: "Required",
                      type: "boolean",
                      initialValue: false,
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
      validation: (Rule) => Rule.required().min(2).max(2),
    }),
    defineField({
      name: "marketingOptInLabel",
      title: "Marketing Opt-in Label",
      type: "string",
      initialValue: "I agree to receive occasional updates from Lash Her by Nataliea.",
      validation: (Rule) => Rule.required(),
    }),
  ],
  preview: {
    prepare() {
      return { title: "Booking Settings" };
    },
  },
});
