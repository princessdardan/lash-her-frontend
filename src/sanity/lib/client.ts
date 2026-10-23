import { createClient } from "next-sanity";

import { apiVersion, dataset, projectId } from "../env";

const isVercelPreview =
  process.env.VERCEL_ENV === "preview" || dataset === "staging-2026-05-10";

export const client = createClient({
  projectId,
  dataset,
  apiVersion,
  useCdn: !isVercelPreview,
});
