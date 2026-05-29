import { createClient } from "@sanity/client";
import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;

loadEnvConfig(process.cwd());

const projectId = assertEnv("NEXT_PUBLIC_SANITY_PROJECT_ID");
const dataset = assertEnv("NEXT_PUBLIC_SANITY_DATASET");
const token = assertEnv("SANITY_WRITE_TOKEN");
const apiVersion = process.env.NEXT_PUBLIC_SANITY_API_VERSION || "2026-03-24";

if (dataset === "production" && process.env.SANITY_SCHEMA_DEPLOY_TARGET !== "production") {
  throw new Error(
    "Refusing to backfill production without SANITY_SCHEMA_DEPLOY_TARGET=production.",
  );
}

const client = createClient({
  projectId,
  dataset,
  apiVersion,
  token,
  useCdn: false,
});

const trainingBlock = {
  _type: "homeTrainingProgramsSection",
  _key: "trainingProgramsFeature",
  trainingProgramsPage: {
    _type: "reference",
    _ref: "trainingProgramsPage",
  },
};

const state = await client.fetch(`{
  "homePageId": *[_id == "homePage"][0]._id,
  "trainingProgramsPageId": *[_id == "trainingProgramsPage"][0]._id,
  "hasTrainingBlock": count(*[_id == "homePage"][0].blocks[_type == "homeTrainingProgramsSection"]) > 0
}`);

if (!state.homePageId) {
  throw new Error(`No homePage document found in ${projectId}/${dataset}.`);
}

if (!state.trainingProgramsPageId) {
  throw new Error(`No trainingProgramsPage document found in ${projectId}/${dataset}.`);
}

if (state.hasTrainingBlock) {
  console.log(`homePage already contains homeTrainingProgramsSection in ${projectId}/${dataset}.`);
  process.exit(0);
}

await client
  .patch("homePage")
  .setIfMissing({ blocks: [] })
  .append("blocks", [trainingBlock])
  .commit({ autoGenerateArrayKeys: false });

console.log(`Added homeTrainingProgramsSection to homePage in ${projectId}/${dataset}.`);

function assertEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }

  return value;
}
