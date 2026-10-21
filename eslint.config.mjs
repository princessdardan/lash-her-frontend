import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
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
