import { randomUUID, timingSafeEqual } from "node:crypto";
import { readReleaseProbeConfiguration } from "../release-probe/handler";

type Probe = NonNullable<ReturnType<typeof readReleaseProbeConfiguration>>;

export function readSchedulerProbeConfiguration(env: Record<string, string | undefined>, now = Date.now()) {
  if (env.LASH_RELEASE_SCHEDULER_QUALIFICATION !== "true") return null;
  const probe = readReleaseProbeConfiguration(env, now);
  const cronSecret = env.CRON_SECRET;
  if (probe?.environment !== "staging" || !cronSecret || cronSecret.length < 16 || cronSecret.length > 8192 ||
      !/^[\x21-\x7e]+$/u.test(cronSecret)) return null;
  return { ...probe, cronSecret, expiresAt: Number(env.LASH_RELEASE_PROBE_EXPIRES_AT) };
}

type Configuration = Probe & { cronSecret: string; expiresAt: number };
export function createSchedulerProbeHandler(deps: {
  configuration(): Configuration | null;
  run(origin: string): Promise<{ ok: true; service: "course"; durationMs: number }>;
  record(value: Record<string, string | number>): void;
  now?: () => number;
}) {
  return async (request: Request): Promise<Response> => {
    try {
      const config = deps.configuration();
      if (!config) return reply(404, { error: "Not found" });
      const actual = Buffer.from(request.headers.get("authorization") ?? "");
      const expected = Buffer.from(`Bearer ${config.cronSecret}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(401, { error: "Unauthorized" });
      // These headers bind the intended job, but are not origin authentication.
      // Actual native origin must also be established from provider evidence.
      if (request.headers.get("x-vercel-cron-schedule") !== "* * * * *" ||
          request.headers.get("user-agent") !== "vercel-cron/1.0") return reply(400, { error: "Invalid schedule request" });
      const now = deps.now ?? Date.now;
      if (now() >= config.expiresAt) return reply(404, { error: "Not found" });
      const invocationId = randomUUID();
      const startedAt = now();
      const result = await deps.run(config.gatewayOrigin);
      if (now() >= config.expiresAt) return reply(503, { error: "Qualification window expired" });
      const evidence = { version: 1, status: "FRONTEND_SCHEDULED_WORKLOAD_PROBE_PASS", invocationId,
        environment: config.environment, projectId: config.projectId, sourceCommit: config.sourceCommit,
        gatewayOrigin: config.gatewayOrigin, startedAt, completedAt: now(), durationMs: result.durationMs };
      // Only this selected receipt is logged. Never log request headers, env,
      // SDK token, cron secret, upstream bodies or raw caught errors.
      deps.record(evidence);
      return reply(200, evidence);
    } catch { return reply(503, { error: "Scheduled release probe failed" }); }
  };
}

function reply(status: number, body: unknown) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
