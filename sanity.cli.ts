import { defineCliConfig } from "sanity/cli";
import { fileURLToPath } from "node:url";
import { SANITY_PROJECT_BINDINGS } from "./src/lib/env/application-environment.mjs";

const DATASET = process.env.NEXT_PUBLIC_SANITY_DATASET ?? "production";
const PROJECT_ID = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ?? SANITY_PROJECT_BINDINGS.productionProjectId;
const DEPLOY_TARGET = process.env.SANITY_SCHEMA_DEPLOY_TARGET;

if (PROJECT_ID !== SANITY_PROJECT_BINDINGS.productionProjectId &&
    PROJECT_ID !== SANITY_PROJECT_BINDINGS.stagingProjectId) {
  throw new Error("Refusing an unreviewed Sanity project.");
}

if (DATASET === "staging-2026-05-10" && PROJECT_ID !== SANITY_PROJECT_BINDINGS.stagingProjectId) {
  throw new Error("Staging schema operations require the isolated staging Sanity project.");
}

if (DATASET === "production" && PROJECT_ID !== SANITY_PROJECT_BINDINGS.productionProjectId) {
  throw new Error("Production schema operations require the production Sanity project.");
}

if (DATASET === "production" && DEPLOY_TARGET !== "production") {
  throw new Error(
    "Refusing to target the production Sanity dataset without SANITY_SCHEMA_DEPLOY_TARGET=production.",
  );
}

export default defineCliConfig({
  // Standalone Studio uses Vite, which does not read Next's tsconfig paths.
  vite: {
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
  },
  api: {
    projectId: PROJECT_ID,
    dataset: DATASET,
  },
});
