"use client";

import { defineConfig } from "sanity";
import { vercelProtectionBypassTool } from "@sanity/vercel-protection-bypass";
import { presentationTool } from "sanity/presentation";
import { structureTool } from "sanity/structure";
import { muxInput } from "sanity-plugin-mux-input";
import { schemaTypes } from "./schemas";
import { resolve } from "./presentation/resolve";
import { structure } from "./structure";
import { apiVersion, dataset, projectId } from "./env";

const singletonTypes = new Set([
  "homePage",
  "contactPage",
  "galleryPage",
  "trainingPage",
  "trainingProgramsPage",
  "productsPage",
  "servicesPage",
  "globalSettings",
  "mainMenu",
]);

const singletonActions = new Set(["publish", "discardChanges", "restore"]);

export default defineConfig({
  name: "default",
  title: "Lash Her by Nataliea",
  basePath: "/studio",
  projectId,
  dataset,
  apiVersion,
  plugins: [
    muxInput({ acceptedMimeTypes: ["video/*"], defaultPublic: true }),
    presentationTool({
      resolve,
      previewUrl: {
        initial: "/",
        previewMode: {
          disable: "/api/draft-mode/disable",
          enable: "/api/draft-mode/enable",
        },
      },
    }),
    vercelProtectionBypassTool(),
    structureTool({ structure }),
  ],
  schema: {
    types: schemaTypes,
    templates: (templates) => [
      ...templates.filter(({ schemaType }) => !singletonTypes.has(schemaType)),
      {
        id: "landing-page-founding-membership",
        title: "Founding Membership Landing Page",
        schemaType: "landingPage",
        value: {
          title: "Founding Membership",
          slug: { _type: "slug", current: "founding-membership" },
          eyebrow: "A new chapter for Lash Her",
          heading: "Become a founding member",
          description:
            "Our new salon is coming. Join the founding membership interest list to hear about opening updates and membership details.",
          signup: {
            heading: "Join the founding list",
            description:
              "Leave your email to receive founding membership and salon opening updates.",
            submitLabel: "Join the founding list",
            successMessage:
              "You're on the founding list. We'll email you with membership details and salon opening updates.",
          },
        },
      },
    ],
  },
  document: {
    actions: (input, context) =>
      singletonTypes.has(context.schemaType)
        ? input.filter(({ action }) => action && singletonActions.has(action))
        : input,
  },
});
