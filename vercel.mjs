import { createVercelConfiguration } from "./ops/platform/vercel-config.mjs";

export const config = createVercelConfiguration(process.env);
