import "server-only";
import { randomUUID } from "node:crypto";
import { resolveCustomerAuthConfiguration } from "@/lib/customer-auth/policy";
import { WriterAdmissionError } from "@/lib/writer-admission/config";
import { runAccountWriter } from "./context";
import { AccountLifecycleError, canonicalUuid, parseAccountRequest, type AccountAction } from "./policy";
import { getAccountCustomerSession, type AccountCustomerSession } from "./session";
import { createAccountLifecycleStore, type AccountLifecycleStore } from "./store";

export const isAccountLifecycleEnabled = () => process.env.CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED === "true";
const response = (body: unknown, status = 200, requestId = randomUUID()) => Response.json(body, { status, headers: { "cache-control": "private, no-store", "pragma": "no-cache", "x-request-id": requestId, "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });

export function createAccountHandler(dependencies: {
  enabled?: () => boolean;
  origin?: () => string | null;
  session?: () => Promise<AccountCustomerSession | null>;
  store?: () => AccountLifecycleStore;
  run?: typeof runAccountWriter;
} = {}) {
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    try {
      if (!(dependencies.enabled ?? isAccountLifecycleEnabled)()) return response({ error: "unavailable", requestId }, 404, requestId);
      const origin = (dependencies.origin ?? (() => resolveCustomerAuthConfiguration()?.origin ?? null))();
      const url = new URL(request.url);
      if (!origin || url.origin !== origin || url.search || request.headers.get("sec-fetch-site") === "cross-site") throw new AccountLifecycleError(403, "request_denied");
      if (request.method !== "GET" && (request.headers.get("origin") !== origin || request.headers.get("content-type")?.split(";", 1)[0].toLowerCase() !== "application/json")) throw new AccountLifecycleError(403, "request_denied");
      const session = await (dependencies.session ?? getAccountCustomerSession)();
      if (!session) throw new AccountLifecycleError(401, "sign_in_required");
      const store = (dependencies.store ?? createAccountLifecycleStore)();
      if (request.method === "GET" && url.pathname === "/api/account") return response(await store.overview(session.userId), 200, requestId);
      const exportMatch = /^\/api\/account\/exports\/([a-f0-9-]+)$/u.exec(url.pathname);
      if (request.method === "GET" && exportMatch && canonicalUuid(exportMatch[1])) {
        const data = await store.getExport(session.userId, exportMatch[1]);
        if (!data) throw new AccountLifecycleError(404, "export_unavailable");
        const result = response(data, 200, requestId);
        result.headers.set("content-disposition", 'attachment; filename="lash-her-account.json"');
        return result;
      }
      if (request.method !== "POST" || !["/api/account/commands", "/api/account/preferences"].includes(url.pathname)) throw new AccountLifecycleError(404, "unavailable");
      const body = await readAccountJson(request);
      if (url.pathname === "/api/account/preferences") {
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join(",") !== "learningUpdates" || !("learningUpdates" in body) || typeof body.learningUpdates !== "boolean") throw new AccountLifecycleError(400, "invalid_request");
        const learningUpdates = body.learningUpdates;
        await (dependencies.run ?? runAccountWriter)("new-work", () => store.updatePreferences(session, learningUpdates));
        return response({ saved: true }, 200, requestId);
      }
      const input = parseAccountRequest(body);
      if (!["export", "delete"].includes(input.action)) throw new AccountLifecycleError(403, "account_action_denied");
      const command = await (dependencies.run ?? runAccountWriter)("new-work", () => store.request({ userId: session.userId, ...input, requester: { kind: "customer", session } }));
      return response({ commandId: command.commandId, action: command.action, accountVersion: command.accountVersion, status: "pending" }, 202, requestId);
    } catch (error) {
      if (error instanceof AccountLifecycleError) return response({ error: error.code, requestId }, error.status, requestId);
      if (error instanceof WriterAdmissionError) return response({ error: "temporarily_unavailable", requestId }, 503, requestId);
      return response({ error: "temporarily_unavailable", requestId }, 503, requestId);
    }
  };
}

export async function readAccountJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new AccountLifecycleError(400, "invalid_request");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4_096) { await reader.cancel(); throw new AccountLifecycleError(413, "invalid_request"); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AccountLifecycleError(400, "invalid_request"); }
}

export async function requestAdminAccountAction(input: { userId: string; action: AccountAction; idempotencyKey: string }) {
  if (!isAccountLifecycleEnabled() || !canonicalUuid(input.userId)) throw new AccountLifecycleError(404, "unavailable");
  const parsed = parseAccountRequest({ action: input.action, idempotencyKey: input.idempotencyKey });
  return runAccountWriter("new-work", async () => {
    const { requireAdminActor, requireFreshAdminGoogleAuthentication } = await import("@/lib/admin/auth");
    const actor = await requireAdminActor();
    if (actor.user.role !== "owner" || actor.user.status !== "active" || actor.developerMode) throw new AccountLifecycleError(403, "account_action_denied");
    await requireFreshAdminGoogleAuthentication();
    return createAccountLifecycleStore().request({ ...parsed, userId: input.userId, requester: { kind: "admin", adminId: actor.user.id } });
  });
}
