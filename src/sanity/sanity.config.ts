'use client'

import { defineConfig } from "sanity";
import { vercelProtectionBypassTool } from "@sanity/vercel-protection-bypass";
import { presentationTool } from "sanity/presentation";
import { structureTool } from "sanity/structure";
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
  "globalSettings",
  "mainMenu",
  "bookingSettings",
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
    templates: (templates) =>
      templates.filter(({ schemaType }) => !singletonTypes.has(schemaType)),
  },
  document: {
    actions: (input, context) =>
      singletonTypes.has(context.schemaType)
        ? input.filter(({ action }) => action && singletonActions.has(action))
        : input,
  },
});
