import "server-only";

/** Each integration capability rolls out independently of the legacy site. */
export const INTEGRATION_ROLLOUT_FLAGS = Object.freeze({
  customerAccess: "INTEGRATION_CUSTOMER_ACCESS_ENABLED",
  courseReads: "INTEGRATION_COURSE_READS_ENABLED",
  checkout: "INTEGRATION_CHECKOUT_ENABLED",
  entitlementRecovery: "INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED",
  communityReads: "INTEGRATION_COMMUNITY_READS_ENABLED",
  communityWrites: "INTEGRATION_COMMUNITY_WRITES_ENABLED",
} as const);

export type IntegrationFeature = keyof typeof INTEGRATION_ROLLOUT_FLAGS;

export class IntegrationFeatureDisabledError extends Error {
  readonly code = "integration_feature_disabled";

  constructor() {
    super("Integration feature is disabled");
    this.name = "IntegrationFeatureDisabledError";
  }
}

export function isIntegrationFeatureEnabled(feature: IntegrationFeature): boolean {
  // Dynamic server-only reads avoid NEXT_PUBLIC/build-time flag inlining. An
  // unknown name or malformed value must never enable a capability.
  return Object.hasOwn(INTEGRATION_ROLLOUT_FLAGS, feature)
    && process.env[INTEGRATION_ROLLOUT_FLAGS[feature]] === "true";
}

/** Gate new work before obtaining credentials or starting network/DB work.
 * Authentication, job readiness and feature-specific prerequisites still apply.
 * Disabling checkout/customer access does not disable entitlement recovery.
 */
export async function withIntegrationFeature<T>(feature: IntegrationFeature, operation: () => T | Promise<T>): Promise<T> {
  if (!isIntegrationFeatureEnabled(feature)) throw new IntegrationFeatureDisabledError();
  return operation();
}
