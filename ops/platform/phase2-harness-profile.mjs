// Synthetic owned fixtures only. These keys are generated per invocation and
// never loaded from deployed configuration or reused across trust profiles.
export const phase2Workers = Object.freeze(["course-media", "course-export-cleanup"]);

export function disabledCourseWorkerEnvironment(databaseUrl, worker) {
  if (worker !== "course-media" && worker !== "course-export-cleanup") throw new Error("Unknown Course worker fixture");
  return { DATABASE_TARGET: "staging", STAGING_DATABASE_URL: databaseUrl,
    ...(worker === "course-media" ? { MUX_MEDIA_RECOVERY_ENABLED: "false", MUX_MEDIA_CLEANUP_ENABLED: "false" }
      : { COURSE_ACCOUNT_EXPORT_CLEANUP_ENABLED: "false" }) };
}

export function courseHarnessAuth(phase, { frontendSecret, adminSecret, learnerSecret }) {
  if (phase !== "p1" && phase !== "p2") throw new Error("Explicit harness contract phase required");
  return {
    INTERNAL_SERVICE_JWT_SECRET: frontendSecret,
    INTERNAL_SERVICE_JWT_ISSUER: "lash-her-frontend", INTERNAL_SERVICE_JWT_AUDIENCE: "lash-her-course-api",
    INTERNAL_SERVICE_JWT_ALLOWED_SUBJECTS: phase === "p2" ? "frontend" : "lash-her-frontend",
    ...(phase === "p2" ? { COURSE_ADMIN_JWT_CURRENT_SECRET: adminSecret, COURSE_LEARNER_JWT_CURRENT_SECRET: learnerSecret }
      : { FIRST_PARTY_AUTH_SECRET: adminSecret }),
  };
}
