import { timingSafeEqual } from "node:crypto";
import { resolveApplicationEnvironment, VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import type { FrontendBootstrapProbe } from "@/lib/writer-admission/bootstrap-probe";
import type { FrontendSquareBindingProbe } from "@/lib/writer-admission/square-binding-probe";
import type { FrontendResendBindingProbe } from "@/lib/writer-admission/resend-binding-probe";
import type { FrontendGoogleBindingProbe } from "@/lib/writer-admission/google-binding-probe";
import { readReleaseFeatureControls, type ReleaseFeatureControls } from "@/lib/api-integration/release-feature-controls";
import { resolveWriterAdmissionConfiguration } from "@/lib/writer-admission/config";
import { resolveCustomerAuthConfiguration } from "@/lib/customer-auth/policy";

const MAX_LIFETIME_MS = 60 * 60 * 1000;
const STAGING_AUTHENTICATION_ORIGIN = "https://staging.lashher.com";
const STAGING_GATEWAY_ORIGIN = "https://api-staging.lashher.com";
export const PHASE2_DAY_TWO_WORKLOAD_MODE = "phase2-day-two-workload";
type AuthenticationOrigins = {
  customerOrigin: string;
  adminOrigin: string;
  adminRedirectProxyOrigin: null;
  customerRedirectProxyEnabled: false;
};

function readAuthenticationOrigins(env: Record<string, string | undefined>): AuthenticationOrigins | null {
  try {
    const customer = resolveCustomerAuthConfiguration(env);
    const admin = new URL(env.AUTH_URL ?? env.NEXTAUTH_URL ?? "");
    if (!customer || customer.origin !== STAGING_AUTHENTICATION_ORIGIN || admin.origin !== STAGING_AUTHENTICATION_ORIGIN ||
      admin.username || admin.password || !["/", "/api/auth"].includes(admin.pathname) || admin.search || admin.hash || env.AUTH_REDIRECT_PROXY_URL) return null;
    return { customerOrigin: customer.origin, adminOrigin: admin.origin, adminRedirectProxyOrigin: null, customerRedirectProxyEnabled: false };
  } catch { return null; }
}
type WorkloadConfiguration = {
  environment: "staging" | "production";
  projectId: string;
  sourceCommit: string;
  gatewayOrigin: string;
  featureControls: ReleaseFeatureControls;
  writerAdmissionBinding: { mode: "enforce"; targetSha256: string; producerSha256: string; sourceCommit: string; roleName: string } | null;
};
type Configuration = WorkloadConfiguration & {
  secret: string;
  authenticationOrigins: AuthenticationOrigins | null;
};
type DayTwoConfiguration = WorkloadConfiguration & {
  environment: "staging";
  writerAdmissionBinding: NonNullable<WorkloadConfiguration["writerAdmissionBinding"]>;
  secret: string;
};
type GatewaySmoke = (gatewayOrigin: string) => Promise<{ ok: true; service: "course"; durationMs: number }>;

function readWorkloadConfiguration(env: Record<string, string | undefined>): WorkloadConfiguration | null {
  if (env.VERCEL_ENV !== "production" ||
      !/^[a-f0-9]{40}$/u.test(env.VERCEL_GIT_COMMIT_SHA ?? "") || /^0+$/u.test(env.VERCEL_GIT_COMMIT_SHA ?? "")) return null;
  try {
    const environment = resolveApplicationEnvironment(env);
    if (environment === "local" || !env.VERCEL_PROJECT_ID || !env.VERCEL_GIT_COMMIT_SHA) return null;
    const origin = new URL(env[environment === "production" ? "API_GATEWAY_PRODUCTION_ORIGIN" : "API_GATEWAY_STAGING_ORIGIN"] ?? "");
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return null;
    const admission = resolveWriterAdmissionConfiguration(env);
    return { environment, projectId: env.VERCEL_PROJECT_ID, sourceCommit: env.VERCEL_GIT_COMMIT_SHA, gatewayOrigin: origin.origin,
      featureControls: readReleaseFeatureControls(env), writerAdmissionBinding: admission ? { mode: "enforce",
        targetSha256: admission.target.targetSha256, producerSha256: admission.producerSha256,
        sourceCommit: admission.sourceSha, roleName: admission.target.user } : null };
  } catch { return null; }
}

export function readReleaseProbeConfiguration(
  env: Record<string, string | undefined>, now = Date.now(),
): Configuration | null {
  const secret = env.LASH_RELEASE_PROBE_SECRET;
  const expiresAt = Number(env.LASH_RELEASE_PROBE_EXPIRES_AT);
  if (!secret || !/^[a-f0-9]{64}$/u.test(secret) || !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now || expiresAt > now + MAX_LIFETIME_MS) return null;
  const config = readWorkloadConfiguration(env);
  return config ? { ...config, secret, authenticationOrigins: config.environment === "staging" ? readAuthenticationOrigins(env) : null } : null;
}

export function readPhase2DayTwoWorkloadConfiguration(env: Record<string, string | undefined>): DayTwoConfiguration | null {
  const secret = env.CRON_SECRET?.trim();
  if (!secret || env.VERCEL !== "1" || env.VERCEL_PROJECT_ID !== VERCEL_PROJECT_BINDINGS.stagingProjectId) return null;
  const config = readWorkloadConfiguration(env);
  if (!config || config.environment !== "staging" || config.gatewayOrigin !== STAGING_GATEWAY_ORIGIN || !config.writerAdmissionBinding) return null;
  return { ...config, environment: config.environment, writerAdmissionBinding: config.writerAdmissionBinding, secret };
}

// This handler receives no provider, bootstrap, or other probe capabilities.
export function createPhase2DayTwoWorkloadHandler(deps: {
  configuration(): DayTwoConfiguration | null;
  phase2: GatewaySmoke;
}) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET", "cache-control": "no-store" } });
    if (request.headers.get("x-lash-release-mode") !== PHASE2_DAY_TWO_WORKLOAD_MODE) return reply(400, { error: "Invalid mode" });
    try {
      const config = deps.configuration();
      if (!config) return reply(404, { error: "Not found" });
      if (!hasBearer(request, config.secret)) return reply(401, { error: "Unauthorized" });
      const challenge = request.headers.get("x-lash-release-challenge") ?? "";
      if (!/^[a-f0-9]{64}$/u.test(challenge)) return reply(400, { error: "Invalid challenge" });
      const result = await deps.phase2(config.gatewayOrigin);
      return phase2WorkloadResponse(config, challenge, result.durationMs);
    } catch { return reply(503, { error: "Release probe failed" }); }
  };
}

export function createReleaseProbeHandler(deps: {
  configuration(): Configuration | null;
  run: GatewaySmoke;
  phase2?: GatewaySmoke;
  admission?(source: { environment: string; sourceCommit: string }): Promise<FrontendBootstrapProbe>;
  square?(source: { environment: string; sourceCommit: string }): Promise<FrontendSquareBindingProbe>;
  resend?(source: { environment: string; sourceCommit: string }): Promise<FrontendResendBindingProbe>;
  google?(source: { environment: string; sourceCommit: string }, challenge: string): Promise<FrontendGoogleBindingProbe>;
}) {
  return async (request: Request): Promise<Response> => {
    try {
      const config = deps.configuration();
      if (!config) return reply(404, { error: "Not found" });
      if (!hasBearer(request, config.secret)) return reply(401, { error: "Unauthorized" });
      const challenge = request.headers.get("x-lash-release-challenge") ?? "";
      if (!/^[a-f0-9]{64}$/u.test(challenge)) return reply(400, { error: "Invalid challenge" });
      const mode = request.headers.get("x-lash-release-mode");
      const phase2 = mode === "phase2" || mode === "phase2-auth-origins";
      const authenticationOrigins = mode === "phase2-auth-origins" ? config.authenticationOrigins : undefined;
      if (mode !== null && mode !== "admission-bootstrap" && mode !== "resend-binding" && mode !== "square-binding" && mode !== "google-binding" && !phase2) return reply(400, { error: "Invalid mode" });
      if (phase2 && (config.environment !== "staging" || !deps.phase2 || mode === "phase2-auth-origins" && !authenticationOrigins)) return reply(503, { error: "Release probe failed" });
      if (mode && !phase2 && (config.environment !== "staging" || !deps.admission || mode === "resend-binding" && !deps.resend || mode === "square-binding" && !deps.square || mode === "google-binding" && !deps.google)) return reply(503, { error: "Release probe failed" });
      // No incoming credential is passed upstream. The ordinary transport gets
      // its workload token from this function's current Vercel execution.
      const result = phase2 ? await deps.phase2!(config.gatewayOrigin) : await deps.run(config.gatewayOrigin);
      if (phase2) return phase2WorkloadResponse(config, challenge, result.durationMs, authenticationOrigins ?? undefined);
      const bootstrap = mode ? await deps.admission!({ environment: config.environment, sourceCommit: config.sourceCommit }) : undefined;
      const resend = mode === "resend-binding" ? await deps.resend!({ environment: config.environment, sourceCommit: config.sourceCommit }) : undefined;
      const square = mode === "square-binding" ? await deps.square!({ environment: config.environment, sourceCommit: config.sourceCommit }) : undefined;
      const google = mode === "google-binding" ? await deps.google!({ environment: config.environment, sourceCommit: config.sourceCommit }, challenge) : undefined;
      return reply(200, { version: 1, status: "FRONTEND_WORKLOAD_PROBE_PASS", challenge,
        environment: config.environment, projectId: config.projectId, sourceCommit: config.sourceCommit, gatewayOrigin: config.gatewayOrigin,
        checks: google ? ["gateway-course-catalog", "frontend-admission-bootstrap", "google-binding"] : square ? ["gateway-course-catalog", "frontend-admission-bootstrap", "square-binding"] : resend ? ["gateway-course-catalog", "frontend-admission-bootstrap", "resend-binding"] : bootstrap ? ["gateway-course-catalog", "frontend-admission-bootstrap"] : ["gateway-course-catalog"], durationMs: result.durationMs,
        ...(bootstrap ?? {}), ...(resend ?? {}), ...(square ?? {}), ...(google ?? {}) }, mode === "google-binding");
    } catch { return reply(503, { error: "Release probe failed" }); }
  };
}

function hasBearer(request: Request, secret: string): boolean {
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function phase2WorkloadResponse(config: WorkloadConfiguration, challenge: string, durationMs: number, authenticationOrigins?: AuthenticationOrigins) {
  return reply(200, { version: 1, status: "FRONTEND_WORKLOAD_PROBE_PASS", challenge,
    environment: config.environment, projectId: config.projectId, sourceCommit: config.sourceCommit, gatewayOrigin: config.gatewayOrigin,
    checks: ["gateway-course-catalog-p2"], durationMs, contractPhase: "p2", featureControls: config.featureControls,
    writerAdmissionBinding: config.writerAdmissionBinding, ...(authenticationOrigins ? { authenticationOrigins } : {}) }, true);
}

function reply(status: number, body: unknown, privateResponse = false) {
  return Response.json(body, { status, headers: { "cache-control": privateResponse ? "private, no-store" : "no-store" } });
}
