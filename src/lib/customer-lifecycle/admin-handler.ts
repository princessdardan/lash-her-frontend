import "server-only";
import { randomUUID } from "node:crypto";
import { runAccountWriter } from "./context";
import { isAccountLifecycleEnabled } from "./handler";
import { AccountLifecycleError, canonicalUuid } from "./policy";
import { createAccountLifecycleStore } from "./store";
import { hasConfiguredRequestOrigin } from "@/lib/api-integration/request-origin";
import { matchesP506OriginHeaders, resolveP506CandidateOrigin } from "@/lib/env/p506-candidate-origin";

export function resolveAdminAccountRequestOrigin(request: Request): string {
  const candidateOrigin = resolveP506CandidateOrigin();
  const origin = candidateOrigin ?? new URL(process.env.CUSTOMER_AUTH_URL ?? "").origin;
  if (!hasConfiguredRequestOrigin(request, origin) ||
    (candidateOrigin && !matchesP506OriginHeaders(request.headers, candidateOrigin))) {
    throw new AccountLifecycleError(403, "request_denied");
  }
  return origin;
}

export async function getAdminAccountExport(request: Request, userId: string, commandId: string): Promise<Response> {
  const requestId = randomUUID(), headers = { "cache-control": "private, no-store", "x-request-id": requestId, "x-content-type-options": "nosniff" };
  try {
    if (!isAccountLifecycleEnabled()) throw new AccountLifecycleError(404, "unavailable");
    resolveAdminAccountRequestOrigin(request);
    const url = new URL(request.url);
    if (url.search || request.headers.get("sec-fetch-site") === "cross-site" || !canonicalUuid(userId) || !canonicalUuid(commandId)) throw new AccountLifecycleError(403, "request_denied");
    const data = await runAccountWriter("new-work", async () => {
      const { requireAdminActor, requireFreshAdminGoogleAuthentication } = await import("@/lib/admin/auth");
      const actor = await requireAdminActor();
      if (actor.user.role !== "owner" || actor.user.status !== "active" || actor.developerMode) throw new AccountLifecycleError(403, "account_action_denied");
      await requireFreshAdminGoogleAuthentication();
      return createAccountLifecycleStore().getExport(userId, commandId);
    });
    if (!data) throw new AccountLifecycleError(404, "export_unavailable");
    return Response.json(data, { headers: { ...headers, "content-disposition": 'attachment; filename="lash-her-account.json"' } });
  } catch (error) {
    return Response.json({ error: error instanceof AccountLifecycleError ? error.code : "temporarily_unavailable", requestId }, { status: error instanceof AccountLifecycleError ? error.status : 503, headers });
  }
}
