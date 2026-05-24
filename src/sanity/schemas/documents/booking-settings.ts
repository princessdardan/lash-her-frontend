import { CalendarIcon } from "@sanity/icons";
import { defineArrayMember, defineField, defineType } from "sanity";

const WEEKDAY_OPTIONS = [
  { title: "Monday", value: "monday" },
  { title: "Tuesday", value: "tuesday" },
  { title: "Wednesday", value: "wednesday" },
  { title: "Thursday", value: "thursday" },
  { title: "Friday", value: "friday" },
  { title: "Saturday", value: "saturday" },
  { title: "Sunday", value: "sunday" },
];

const DEFAULT_HOURS = [
  { _type: "bookingHoursWindow", day: "monday", isOpen: true, opensAt: "10:00", closesAt: "18:00" },
  { _type: "bookingHoursWindow", day: "tuesday", isOpen: true, opensAt: "10:00", closesAt: "18:00" },
  { _type: "bookingHoursWindow", day: "wednesday", isOpen: true, opensAt: "10:00", closesAt: "18:00" },
  { _type: "bookingHoursWindow", day: "thursday", isOpen: true, opensAt: "10:00", closesAt: "18:00" },
  { _type: "bookingHoursWindow", day: "friday", isOpen: true, opensAt: "10:00", closesAt: "18:00" },
  { _type: "bookingHoursWindow", day: "saturday", isOpen: false, opensAt: "10:00", closesAt: "16:00" },
  { _type: "bookingHoursWindow", day: "sunday", isOpen: false, opensAt: "10:00", closesAt: "16:00" },
];

export const bookingSettings = defineType({
  name: "bookingSettings",
  title: "Booking Settings",
  type: "document",
  icon: CalendarIcon,
  groups: [
    { name: "calendar", title: "Calendar" },
    { name: "rules", title: "Booking Rules" },
    { name: "hours", title: "Hours" },
    { name: "intake", title: "Client Intake" },
  ],
  fields: [
    defineField({
      name: "calendarId",
      title: "Google Calendar ID",
      type: "string",
      group: "calendar",
      description: "Use primary for the connected Gmail primary calendar, or a specific Google Calendar ID.",
      initialValue: "primary",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "bookingHorizonDays",
      title: "Booking Horizon Days",
      type: "number",
      group: "rules",
      initialValue: 30,
      validation: (Rule) => Rule.required().integer().min(1).max(180),
    }),
    defineField({
      name: "minimumLeadTimeHours",
      title: "Minimum Lead Time Hours",
      type: "number",
      group: "rules",
      initialValue: 24,
      validation: (Rule) => Rule.required().integer().min(0).max(720),
    }),
    defineField({
      name: "timezone",
      title: "Booking Timezone",
      type: "string",
      group: "rules",
      initialValue: "America/Toronto",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "bufferMinutes",
      title: "Buffer Minutes",
      type: "number",
      group: "rules",
      description: "Applies before and after each booking so adjacent services share the same buffer.",
      initialValue: 15,
      validation: (Rule) => Rule.required().integer().min(0).max(120),
    }),
    defineField({
      name: "slotIntervalMinutes",
      title: "Slot Interval Minutes",
      type: "number",
      group: "rules",
      initialValue: 15,
      validation: (Rule) => Rule.required().integer().min(5).max(120),
    }),
    defineField({
      name: "hoursOfOperation",
      title: "Hours of Operation",
      type: "array",
      group: "hours",
      initialValue: DEFAULT_HOURS,
      of: [
        defineArrayMember({
          name: "bookingHoursWindow",
          title: "Day",
          type: "object",
          fields: [
            defineField({
              name: "day",
              title: "Day",
              type: "string",
              options: { list: WEEKDAY_OPTIONS, layout: "dropdown" },
              validation: (Rule) => Rule.required(),
            }),
            defineField({ name: "isOpen", title: "Open", type: "boolean", initialValue: true, validation: (Rule) => Rule.required() }),
            defineField({ name: "opensAt", title: "Opens At", type: "string", initialValue: "10:00", validation: (Rule) => Rule.required().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { name: "24-hour time" }) }),
            defineField({ name: "closesAt", title: "Closes At", type: "string", initialValue: "18:00", validation: (Rule) => Rule.required().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { name: "24-hour time" }) }),
          ],
          preview: {
            select: { title: "day", isOpen: "isOpen", opensAt: "opensAt", closesAt: "closesAt" },
            prepare({ title, isOpen, opensAt, closesAt }) {
              return { title, subtitle: isOpen ? `${opensAt}–${closesAt}` : "Closed" };
            },
          },
        }),
      ],
      validation: (Rule) => Rule.required().min(7).max(7),
    }),
    defineField({
      name: "intakeQuestions",
      title: "Client Intake Questions",
      type: "array",
      group: "intake",
      of: [
        defineArrayMember({
          name: "bookingQuestion",
          title: "Question",
          type: "object",
          fields: [
            defineField({ name: "id", title: "ID", type: "string", validation: (Rule) => Rule.required().regex(/^[a-z0-9-]+$/) }),
            defineField({ name: "label", title: "Label", type: "string", validation: (Rule) => Rule.required() }),
            defineField({
              name: "inputType",
              title: "Input Type",
              type: "string",
              options: { list: ["text", "textarea", "select"], layout: "radio" },
              validation: (Rule) => Rule.required(),
            }),
            defineField({ name: "required", title: "Required", type: "boolean", initialValue: false }),
            defineField({ name: "options", title: "Options", type: "array", of: [defineArrayMember({ type: "string" })], hidden: ({ parent }) => parent?.inputType !== "select" }),
          ],
        }),
      ],
    }),
    defineField({
      name: "marketingOptInLabel",
      title: "Marketing Opt-in Label",
      type: "string",
      group: "intake",
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
