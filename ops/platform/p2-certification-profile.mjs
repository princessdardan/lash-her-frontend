import { isDeepStrictEqual } from "node:util";

export const P2_CERTIFICATION_PROFILE = Object.freeze({
  version: 1, profile: "p2-learning-lifecycle",
  featureControls: Object.freeze({
    INTEGRATION_CUSTOMER_ACCESS_ENABLED: true, INTEGRATION_COURSE_READS_ENABLED: true,
    INTEGRATION_CHECKOUT_ENABLED: false, INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED: false,
    INTEGRATION_COMMUNITY_READS_ENABLED: false, INTEGRATION_COMMUNITY_WRITES_ENABLED: false,
    INTEGRATION_LEARNING_ROUTES_ENABLED: true, CUSTOMER_AUTH_ENABLED: true,
    CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED: true, CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED: true,
  }),
  nativeSchedulesEnabled: false,
});

export function prepareP2CertificationProfile(value) {
  if (!isDeepStrictEqual(value, P2_CERTIFICATION_PROFILE)) throw new Error("P2_CERTIFICATION_PROFILE_REFUSED");
  return structuredClone(P2_CERTIFICATION_PROFILE);
}

export const P2_CERTIFICATION_RUNTIME_FLAGS = Object.freeze({
  "course-api": Object.freeze({ COURSE_ACCOUNT_LIFECYCLE_ENABLED: "true" }),
  "community-api": Object.freeze({ COMMUNITY_ACCOUNT_LIFECYCLE_ENABLED: "true" }),
  "course-media": Object.freeze({ MUX_MEDIA_RECOVERY_ENABLED: "true", MUX_MEDIA_CLEANUP_ENABLED: "true" }),
  "course-export-cleanup": Object.freeze({ COURSE_ACCOUNT_EXPORT_CLEANUP_ENABLED: "true" }),
});
