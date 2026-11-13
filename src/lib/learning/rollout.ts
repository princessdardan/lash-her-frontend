import "server-only";

import { isIntegrationFeatureEnabled } from "@/lib/api-integration/rollout-flags";

/** A presentation switch, separate from the six independently gated capabilities.
 * False preserves the Sanity/browser-cookie course route through Phase 3. */
export function learningRoutesEnabled(): boolean {
  return process.env.INTEGRATION_LEARNING_ROUTES_ENABLED === "true"
    && isIntegrationFeatureEnabled("courseReads");
}

export function legacyProgressImportEnabled(): boolean {
  return process.env.INTEGRATION_LEGACY_PROGRESS_IMPORT_ENABLED === "true" &&
    learningRoutesEnabled() && isIntegrationFeatureEnabled("customerAccess");
}

export function legacyCourseFallbackEnabled(slug: string): boolean {
  return (process.env.INTEGRATION_LEGACY_COURSE_FALLBACK_SLUGS ?? "")
    .split(",").some(value => value.trim() === slug);
}
