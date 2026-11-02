import { createVercelConfiguration } from "./ops/platform/vercel-config.mjs";

// Keep the pre-build Git policy statically readable. Only the build-time
// scheduler list is generated through imported code below.
export const config = {
  git: {
    deploymentEnabled: {
      main: false,
      staging: false,
      "codex/p1-platform-foundation-20261101": false,
      "codex/p1-static-git-release-policy-20261102": false,
    },
  },
};

config.crons = createVercelConfiguration(process.env).crons;
