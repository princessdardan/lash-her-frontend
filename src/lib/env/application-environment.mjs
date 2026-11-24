// Reviewed deployment identities, not environment-variable overrides. Verified
// against the dedicated Vercel projects on 2026-10-22; see P1-02 setup evidence.
export const VERCEL_PROJECT_BINDINGS = Object.freeze({
  teamId: "team_2Hrn5eMZyZxfAWdmYvyKi9t3",
  productionProjectId: "prj_wvBLVsXzC1XMZ11hSIfBi2bHXsyy",
  stagingProjectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM",
});

// Separate project credentials provide CMS isolation without a shared-plan
// advanced-roles entitlement. The staging project was created on 2026-10-22.
export const SANITY_PROJECT_BINDINGS = Object.freeze({
  productionProjectId: "3auncj84",
  stagingProjectId: "7o23yrvk",
});

/**
 * Vercel's deployment target is distinct from the business environment.
 * This pure module is shared by prebuild checks and server-only provider code.
 * @param {Record<string, string | undefined>} env
 * @param {{teamId: string, productionProjectId: string, stagingProjectId: string | null}} bindings
 * @returns {"local" | "staging" | "production"}
 */
export function resolveApplicationEnvironment(
  env,
  bindings = VERCEL_PROJECT_BINDINGS,
) {
  const hosted =
    env.VERCEL === "1" ||
    env.VERCEL_ENV === "production" ||
    env.VERCEL_ENV === "preview" ||
    Boolean(env.VERCEL_PROJECT_ID && env.VERCEL_ENV !== "development");
  const appEnv = env.APP_ENV;
  if (!hosted || env.VERCEL_ENV === "development") {
    if (appEnv === undefined || appEnv === "local") return "local";
    throw new Error(
      "APP_ENV=staging or production requires a verified Vercel deployment",
    );
  }

  if (appEnv !== "staging" && appEnv !== "production") {
    throw new Error("Hosted deployments require APP_ENV=staging or production");
  }
  if (env.VERCEL_ENV !== "production" && env.VERCEL_ENV !== "preview") {
    throw new Error("Hosted deployments require a supported VERCEL_ENV");
  }
  if (env.VERCEL_TARGET_ENV !== env.VERCEL_ENV) {
    throw new Error(
      "VERCEL_TARGET_ENV must match the reviewed production or preview target",
    );
  }
  if (
    !bindings.teamId ||
    !bindings.productionProjectId ||
    bindings.productionProjectId === bindings.stagingProjectId
  ) {
    throw new Error("Invalid reviewed Vercel project bindings");
  }
  // This is explicit protected release configuration. Vercel does not expose
  // VERCEL_ORG_ID as a system runtime variable. Gateway OIDC signature/claim
  // verification remains a separate authentication boundary in P1-03.
  if (env.APP_VERCEL_TEAM_ID !== bindings.teamId) {
    throw new Error("APP_VERCEL_TEAM_ID does not match the reviewed team");
  }

  if (env.VERCEL_ENV === "preview") {
    if (
      appEnv !== "staging" ||
      !env.VERCEL_PROJECT_ID ||
      (env.VERCEL_PROJECT_ID !== bindings.productionProjectId &&
        env.VERCEL_PROJECT_ID !== bindings.stagingProjectId)
    ) {
      throw new Error(
        "Preview deployments require staging configuration and a reviewed project",
      );
    }
    return "staging";
  }

  const expectedProject =
    appEnv === "production"
      ? bindings.productionProjectId
      : bindings.stagingProjectId;
  if (!expectedProject) {
    throw new Error("Dedicated staging Vercel project has not been recorded");
  }
  if (env.VERCEL_PROJECT_ID !== expectedProject) {
    throw new Error(
      "APP_ENV does not match the reviewed Vercel project/target binding",
    );
  }
  return appEnv;
}

/**
 * @param {string} name
 * @param {string | undefined} value
 * @param {{production: string, staging: string}} values
 * @param {Record<string, string | undefined>} env
 */
export function assertProviderEnvironment(name, value, values, env) {
  const appEnv = resolveApplicationEnvironment(env);
  if (appEnv !== "local" && value !== values[appEnv]) {
    throw new Error(`${appEnv} deployment requires ${name}=${values[appEnv]}`);
  }
}
