import { defineField, defineType } from "sanity";

export const servicesPage = defineType({
  name: "servicesPage",
  title: "Services Page",
  type: "document",
  fields: [
    defineField({
      name: "redirectToFresha",
      title: "Send visitors directly to Fresha",
      type: "boolean",
      initialValue: false,
      description:
        "When enabled and published, /services opens Lash Her's Fresha page. Turn this off to show the website service listing again. Service content is kept in either mode.",
    }),
  ],
  preview: {
    prepare: () => ({ title: "Services Page" }),
  },
});
