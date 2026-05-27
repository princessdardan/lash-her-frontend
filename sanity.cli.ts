import { defineCliConfig } from "sanity/cli";

const DATASET = process.env.NEXT_PUBLIC_SANITY_DATASET ?? "production";
const DEPLOY_TARGET = process.env.SANITY_SCHEMA_DEPLOY_TARGET;

if (DATASET === "production" && DEPLOY_TARGET !== "production") {
  throw new Error(
    "Refusing to target the production Sanity dataset without SANITY_SCHEMA_DEPLOY_TARGET=production.",
  );
}

export default defineCliConfig({
  api: {
    projectId: "3auncj84",
    dataset: DATASET,
  },
});
