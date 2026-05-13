import "server-only";

import { createClient } from "@sanity/client";

import { apiVersion, dataset, projectId } from "../env";

export const formClient = createClient({
  projectId,
  dataset,
  apiVersion,
  useCdn: false,
  token: process.env.SANITY_FORM_TOKEN,
});
