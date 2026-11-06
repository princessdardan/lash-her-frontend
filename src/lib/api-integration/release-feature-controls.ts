/** Nonsecret runtime controls observed by the authenticated release probe. */
export const RELEASE_FEATURE_CONTROL_NAMES = [
  "INTEGRATION_CUSTOMER_ACCESS_ENABLED", "INTEGRATION_COURSE_READS_ENABLED", "INTEGRATION_CHECKOUT_ENABLED",
  "INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED", "INTEGRATION_COMMUNITY_READS_ENABLED", "INTEGRATION_COMMUNITY_WRITES_ENABLED",
  "INTEGRATION_LEARNING_ROUTES_ENABLED", "CUSTOMER_AUTH_ENABLED", "CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED", "CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED",
] as const;

export type ReleaseFeatureControls = Record<(typeof RELEASE_FEATURE_CONTROL_NAMES)[number], boolean>;

export function readReleaseFeatureControls(env: Record<string, string | undefined>): ReleaseFeatureControls {
  return Object.fromEntries(RELEASE_FEATURE_CONTROL_NAMES.map(name => [name, env[name] === "true"])) as ReleaseFeatureControls;
}
