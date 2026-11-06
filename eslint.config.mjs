import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // These immutable standalone Node control snapshots are hash-bound evidence.
    // Their local `module` variable is never compiled by the Next.js bundler.
    files: [
      "docs/api-integration/baselines/2026-11-05-historical-capability-followup/run-prior-control.mjs",
      "docs/api-integration/baselines/2026-11-05-historical-capability-residuals/run-prior-residual-control.mjs",
    ],
    rules: { "@next/next/no-assign-module-variable": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".sanity/**",
    ".worktrees/**",
    ".tmp/**",
    // Sibling Claude Code worktrees carry their own .next build output; never lint them.
    ".claude/worktrees/**",
    "out/**",
    "build/**",
    // Reviewed upstream forks are verified by source hashes and regression tests.
    "vendor/security/**",
    "test-results/**",
    "playwright-report/**",
    "blob-report/**",
    "coverage/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
