import { defineCliConfig } from "sanity/cli";
import { fileURLToPath } from "node:url";

const DATASET = process.env.NEXT_PUBLIC_SANITY_DATASET ?? "production";
const DEPLOY_TARGET = process.env.SANITY_SCHEMA_DEPLOY_TARGET;
const expectedProjectId =
  DATASET === "staging-2026-05-10" ? "7o23yrvk" : "3auncj84";
const projectId =
  process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ?? expectedProjectId;

if (projectId !== expectedProjectId) {
  throw new Error(
    "Sanity schema commands require the reviewed project for the selected dataset.",
  );
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
    projectId,
    dataset: DATASET,
  },
});
