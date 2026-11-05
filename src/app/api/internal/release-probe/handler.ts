import { timingSafeEqual } from "node:crypto";
import { resolveApplicationEnvironment } from "@/lib/env/application-environment.mjs";
import type { FrontendBootstrapProbe } from "@/lib/writer-admission/bootstrap-probe";
import type { FrontendSquareBindingProbe } from "@/lib/writer-admission/square-binding-probe";
import type { FrontendResendBindingProbe } from "@/lib/writer-admission/resend-binding-probe";
import type { FrontendGoogleBindingProbe } from "@/lib/writer-admission/google-binding-probe";

const MAX_LIFETIME_MS = 60 * 60 * 1000;
type Configuration = {
  environment: "staging" | "production";
  projectId: string;
  sourceCommit: string;
  gatewayOrigin: string;
  secret: string;
};

export function readReleaseProbeConfiguration(
  env: Record<string, string | undefined>, now = Date.now(),
): Configuration | null {
  const secret = env.LASH_RELEASE_PROBE_SECRET;
  const expiresAt = Number(env.LASH_RELEASE_PROBE_EXPIRES_AT);
  if (!secret || !/^[a-f0-9]{64}$/u.test(secret) || !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now || expiresAt > now + MAX_LIFETIME_MS || env.VERCEL_ENV !== "production" ||
      !/^[a-f0-9]{40}$/u.test(env.VERCEL_GIT_COMMIT_SHA ?? "") || /^0+$/u.test(env.VERCEL_GIT_COMMIT_SHA ?? "")) return null;
  try {
    const environment = resolveApplicationEnvironment(env);
    if (environment === "local" || !env.VERCEL_PROJECT_ID || !env.VERCEL_GIT_COMMIT_SHA) return null;
    const origin = new URL(env[environment === "production" ? "API_GATEWAY_PRODUCTION_ORIGIN" : "API_GATEWAY_STAGING_ORIGIN"] ?? "");
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return null;
    return { environment, projectId: env.VERCEL_PROJECT_ID, sourceCommit: env.VERCEL_GIT_COMMIT_SHA, gatewayOrigin: origin.origin, secret };
  } catch { return null; }
}

export function createReleaseProbeHandler(deps: {
  configuration(): Configuration | null;
  run(gatewayOrigin: string): Promise<{ ok: true; service: "course"; durationMs: number }>;
  phase2?(gatewayOrigin: string): Promise<{ ok: true; service: "course"; durationMs: number }>;
  admission?(source: { environment: string; sourceCommit: string }): Promise<FrontendBootstrapProbe>;
  square?(source: { environment: string; sourceCommit: string }): Promise<FrontendSquareBindingProbe>;
  resend?(source: { environment: string; sourceCommit: string }): Promise<FrontendResendBindingProbe>;
  google?(source: { environment: string; sourceCommit: string }, challenge: string): Promise<FrontendGoogleBindingProbe>;
}) {
  return async (request: Request): Promise<Response> => {
    try {
      const config = deps.configuration();
      if (!config) return reply(404, { error: "Not found" });
      const actual = Buffer.from(request.headers.get("authorization") ?? "");
      const expected = Buffer.from(`Bearer ${config.secret}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(401, { error: "Unauthorized" });
      const challenge = request.headers.get("x-lash-release-challenge") ?? "";
      if (!/^[a-f0-9]{64}$/u.test(challenge)) return reply(400, { error: "Invalid challenge" });
      const mode = request.headers.get("x-lash-release-mode");
      if (mode !== null && mode !== "admission-bootstrap" && mode !== "resend-binding" && mode !== "square-binding" && mode !== "google-binding" && mode !== "phase2") return reply(400, { error: "Invalid mode" });
      if (mode === "phase2" && (config.environment !== "staging" || !deps.phase2)) return reply(503, { error: "Release probe failed" });
      if (mode && mode !== "phase2" && (config.environment !== "staging" || !deps.admission || mode === "resend-binding" && !deps.resend || mode === "square-binding" && !deps.square || mode === "google-binding" && !deps.google)) return reply(503, { error: "Release probe failed" });
      // No incoming credential is passed upstream. The ordinary transport gets
      // its workload token from this function's current Vercel execution.
      const result = mode === "phase2" ? await deps.phase2!(config.gatewayOrigin) : await deps.run(config.gatewayOrigin);
      const bootstrap = mode && mode !== "phase2" ? await deps.admission!({ environment: config.environment, sourceCommit: config.sourceCommit }) : undefined;
      const resend = mode === "resend-binding" ? await deps.resend!({ environment: config.environment, sourceCommit: config.sourceCommit }) : undefined;
      const square = mode === "square-binding" ? await deps.square!({ environment: config.environment, sourceCommit: config.sourceCommit }) : undefined;
      const google = mode === "google-binding" ? await deps.google!({ environment: config.environment, sourceCommit: config.sourceCommit }, challenge) : undefined;
      return reply(200, { version: 1, status: "FRONTEND_WORKLOAD_PROBE_PASS", challenge,
        environment: config.environment, projectId: config.projectId, sourceCommit: config.sourceCommit, gatewayOrigin: config.gatewayOrigin,
        checks: mode === "phase2" ? ["gateway-course-catalog-p2"] : google ? ["gateway-course-catalog", "frontend-admission-bootstrap", "google-binding"] : square ? ["gateway-course-catalog", "frontend-admission-bootstrap", "square-binding"] : resend ? ["gateway-course-catalog", "frontend-admission-bootstrap", "resend-binding"] : bootstrap ? ["gateway-course-catalog", "frontend-admission-bootstrap"] : ["gateway-course-catalog"], durationMs: result.durationMs,
        ...(mode === "phase2" ? { contractPhase: "p2" } : {}),
        ...(bootstrap ?? {}), ...(resend ?? {}), ...(square ?? {}), ...(google ?? {}) }, mode === "phase2" || mode === "google-binding");
    } catch { return reply(503, { error: "Release probe failed" }); }
  };
}

function reply(status: number, body: unknown, privateResponse = false) {
  return Response.json(body, { status, headers: { "cache-control": privateResponse ? "private, no-store" : "no-store" } });
}
