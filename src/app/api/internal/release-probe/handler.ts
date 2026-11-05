import { timingSafeEqual } from "node:crypto";
import { resolveApplicationEnvironment } from "@/lib/env/application-environment.mjs";
import type { FrontendBootstrapProbe } from "@/lib/writer-admission/bootstrap-probe";
import type { FrontendResendBindingProbe } from "@/lib/writer-admission/resend-binding-probe";

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
  admission?(source: { environment: string; sourceCommit: string }): Promise<FrontendBootstrapProbe>;
  resend?(source: { environment: string; sourceCommit: string }): Promise<FrontendResendBindingProbe>;
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
      if (mode !== null && mode !== "admission-bootstrap" && mode !== "resend-binding") return reply(400, { error: "Invalid mode" });
      if (mode && (config.environment !== "staging" || !deps.admission || mode === "resend-binding" && !deps.resend)) return reply(503, { error: "Release probe failed" });
      // No incoming credential is passed upstream. The ordinary transport gets
      // its workload token from this function's current Vercel execution.
      const result = await deps.run(config.gatewayOrigin);
      const bootstrap = mode ? await deps.admission!({ environment: config.environment, sourceCommit: config.sourceCommit }) : undefined;
      const resend = mode === "resend-binding" ? await deps.resend!({ environment: config.environment, sourceCommit: config.sourceCommit }) : undefined;
      return reply(200, { version: 1, status: "FRONTEND_WORKLOAD_PROBE_PASS", challenge,
        environment: config.environment, projectId: config.projectId, sourceCommit: config.sourceCommit, gatewayOrigin: config.gatewayOrigin,
        checks: resend ? ["gateway-course-catalog", "frontend-admission-bootstrap", "resend-binding"] : bootstrap ? ["gateway-course-catalog", "frontend-admission-bootstrap"] : ["gateway-course-catalog"], durationMs: result.durationMs,
        ...(bootstrap ?? {}), ...(resend ?? {}) });
    } catch { return reply(503, { error: "Release probe failed" }); }
  };
}

function reply(status: number, body: unknown) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
