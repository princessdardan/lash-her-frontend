import { timingSafeEqual } from "node:crypto";
import { AdminAuthError } from "@/lib/admin/types";

interface Dependencies {
  enabled(): boolean;
  run(): Promise<{ ok: true; service: "course"; durationMs: number }>;
}

export function createAdminGatewaySmokeHandler(deps: Dependencies & { authorize(): Promise<unknown> }) {
  return async (): Promise<Response> => {
    if (!deps.enabled()) return reply(404, { error: "Not found" });
    try { await deps.authorize(); }
    catch (error) {
      if (error instanceof AdminAuthError) {
        return reply(error.code === "unauthenticated" ? 401 : 403, { error: "Authentication required or forbidden" });
      }
      return reply(503, { error: "Service unavailable" });
    }
    return smoke(deps);
  };
}

export function createScheduledGatewaySmokeHandler(deps: Dependencies & { getSecret(): string | undefined }) {
  return async (request: Request): Promise<Response> => {
    const secret = deps.getSecret()?.trim();
    if (!deps.enabled() || !secret) return reply(404, { error: "Not found" });
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${secret}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(401, { error: "Unauthorized" });
    return smoke(deps);
  };
}

async function smoke(deps: Dependencies) {
  try { return reply(200, await deps.run()); }
  catch { return reply(503, { error: "Gateway smoke failed" }); }
}

function reply(status: number, body: unknown) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
