import { createVercelConfiguration } from "./ops/platform/vercel-config.mjs";

// Keep the pre-build Git policy statically readable. Only the build-time
// scheduler list is generated through imported code below.
export const config = {
  git: {
    deploymentEnabled: false,
  },
};

config.crons = createVercelConfiguration(process.env).crons;
