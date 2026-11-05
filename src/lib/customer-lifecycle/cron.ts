import "server-only";
import { timingSafeEqual } from "node:crypto";
import { createAccountLifecycleClient } from "@/lib/api-integration/account-lifecycle-client";
import { mintLifecycleServiceToken } from "@/lib/api-integration/lifecycle-service-jwt";
import { runAccountWriter } from "./context";
import { createAccountLifecycleStore } from "./store";
import { processAccountLifecycle } from "./worker";

async function runProductionLifecycleRecovery() {
  return runAccountWriter("recovery", () => processAccountLifecycle({
    store: createAccountLifecycleStore(),
    client: receiver => createAccountLifecycleClient({ receiver, mintServiceToken: () => mintLifecycleServiceToken(receiver),
      // The whole awaited claim/delivery/settlement/export operation already
      // owns admission. Unknown service effects mark that same parent entry.
      run: async (_kind, task) => task(),
    }),
  }));
}

export function createAccountLifecycleCron(dependencies: {
  enabled?: () => boolean;
  secret?: () => string | undefined;
  run?: typeof runProductionLifecycleRecovery;
} = {}) {
  return async (request: Request): Promise<Response> => {
    const headers = { "cache-control": "private, no-store", "retry-after": "30" };
    if (!(dependencies.enabled ?? (() => process.env.CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED === "true"))()) return Response.json({ error: "unavailable" }, { status: 404, headers });
    const secret = (dependencies.secret ?? (() => process.env.CRON_SECRET?.trim()))();
    if (!secret) return Response.json({ error: "unavailable" }, { status: 404, headers });
    const actual = Buffer.from(request.headers.get("authorization") ?? ""), expected = Buffer.from(`Bearer ${secret}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    try {
      const result = await (dependencies.run ?? runProductionLifecycleRecovery)();
      return Response.json(result, { status: result.retrying || result.blocked ? 503 : 200, headers });
    } catch { return Response.json({ error: "temporarily_unavailable" }, { status: 503, headers }); }
  };
}
