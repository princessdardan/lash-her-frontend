import "server-only";
import { randomUUID } from "node:crypto";
import { runAccountWriter } from "./context";
import { isAccountLifecycleEnabled } from "./handler";
import { AccountLifecycleError, canonicalUuid } from "./policy";
import { createAccountLifecycleStore } from "./store";

export async function getAdminAccountExport(request: Request, userId: string, commandId: string): Promise<Response> {
  const requestId = randomUUID(), headers = { "cache-control": "private, no-store", "x-request-id": requestId, "x-content-type-options": "nosniff" };
  try {
    if (!isAccountLifecycleEnabled()) throw new AccountLifecycleError(404, "unavailable");
    const origin = new URL(process.env.CUSTOMER_AUTH_URL ?? "").origin;
    const url = new URL(request.url);
    if (url.origin !== origin || url.search || request.headers.get("sec-fetch-site") === "cross-site" || !canonicalUuid(userId) || !canonicalUuid(commandId)) throw new AccountLifecycleError(403, "request_denied");
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
