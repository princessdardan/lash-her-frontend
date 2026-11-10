import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { resolveCustomerAuthConfiguration } from "@/lib/customer-auth/policy";
import { WriterAdmissionError } from "@/lib/writer-admission/config";
import { hasConfiguredRequestOrigin } from "@/lib/api-integration/request-origin";
import { AdminAuthError, AdminAuthenticationFreshnessError, type AdminActor } from "@/lib/admin/types";
import { currentWriterLifecycleSelection } from "@/lib/writer-admission/context";
import { readInteractiveBrowserRequest } from "@/lib/writer-admission/interactive-proof";
import { runAccountWriter } from "./context";
import { AccountLifecycleError, canonicalUuid, parseAccountRequest, type AccountAction } from "./policy";
import { getAccountCustomerSession, type AccountCustomerSession } from "./session";
import { createAccountLifecycleStore, type AccountLifecycleStore } from "./store";

export const isAccountLifecycleEnabled = () => process.env.CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED === "true";
const response = (body: unknown, status = 200, requestId = randomUUID()) => Response.json(body, { status, headers: { "cache-control": "private, no-store", "pragma": "no-cache", "x-request-id": requestId, "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });

const customerOperations = ["export", "delete", "preferences-on", "preferences-off"] as const;
type LifecycleSelection = readonly [actorKind: "admin" | "customer", actorId: string, userId: string,
  operation: AccountAction | (typeof customerOperations)[number]];

function lifecycleSelectionAllows(selection: string | undefined, ...candidates: LifecycleSelection[]): boolean {
  return selection === undefined || candidates.some(candidate =>
    createHash("sha256").update(JSON.stringify(candidate)).digest("hex") === selection);
}

function requireLifecycleSelection(selection: string | undefined, candidate: LifecycleSelection): void {
  if (!lifecycleSelectionAllows(selection, candidate)) throw new AccountLifecycleError(403, "account_action_denied");
}

export async function canReadAccountOverview(userId: string): Promise<boolean> {
  const selection = (await readInteractiveBrowserRequest())?.lifecycleSelectionSha256;
  return lifecycleSelectionAllows(selection, ...customerOperations.map(operation => ["customer", userId, userId, operation] as const));
}

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
      if (!origin || !hasConfiguredRequestOrigin(request, origin) || url.search || request.headers.get("sec-fetch-site") === "cross-site") throw new AccountLifecycleError(403, "request_denied");
      if (request.method !== "GET" && (request.headers.get("origin") !== origin || request.headers.get("content-type")?.split(";", 1)[0].toLowerCase() !== "application/json")) throw new AccountLifecycleError(403, "request_denied");
      const session = await (dependencies.session ?? getAccountCustomerSession)();
      if (!session) throw new AccountLifecycleError(401, "sign_in_required");
      const store = (dependencies.store ?? createAccountLifecycleStore)();
      if (request.method === "GET" && url.pathname === "/api/account") {
        if (!await canReadAccountOverview(session.userId)) throw new AccountLifecycleError(403, "account_action_denied");
        return response(await store.overview(session.userId), 200, requestId);
      }
      const exportMatch = /^\/api\/account\/exports\/([a-f0-9-]+)$/u.exec(url.pathname);
      if (request.method === "GET" && exportMatch && canonicalUuid(exportMatch[1])) {
        // A command permit has no reviewed export command ID.
        if ((await readInteractiveBrowserRequest())?.lifecycleSelectionSha256) throw new AccountLifecycleError(403, "account_action_denied");
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
        await (dependencies.run ?? runAccountWriter)("new-work", () => {
          requireLifecycleSelection(currentWriterLifecycleSelection(), ["customer", session.userId, session.userId,
            learningUpdates ? "preferences-on" : "preferences-off"]);
          return store.updatePreferences(session, learningUpdates);
        });
        return response({ saved: true }, 200, requestId);
      }
      const input = parseAccountRequest(body);
      if (!["export", "delete"].includes(input.action)) throw new AccountLifecycleError(403, "account_action_denied");
      const command = await (dependencies.run ?? runAccountWriter)("new-work", () => {
        requireLifecycleSelection(currentWriterLifecycleSelection(), ["customer", session.userId, session.userId, input.action]);
        return store.request({ userId: session.userId, ...input, requester: { kind: "customer", session } });
      });
      return response({ commandId: command.commandId, action: command.action, accountVersion: command.accountVersion, status: "pending" }, 202, requestId);
    } catch (error) {
      if (error instanceof AccountLifecycleError) {
        const result = response({ error: error.code, requestId }, error.status, requestId);
        if (error.status === 429) result.headers.set("retry-after", "900");
        return result;
      }
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

type AdminAccountAuthorization = {
  requireAdminActor(): Promise<AdminActor>;
  requireFreshAdminGoogleAuthentication(): Promise<Date>;
  readActiveOwnerId(): Promise<string | null>;
};

async function loadAdminAccountAuthorization(): Promise<AdminAccountAuthorization> {
  const { requireAdminActor, requireFreshAdminGoogleAuthentication } = await import("@/lib/admin/auth");
  return { requireAdminActor, requireFreshAdminGoogleAuthentication, async readActiveOwnerId() {
    const { auth } = await import("@/auth");
    const user = (await auth())?.user;
    if (user?.isEmailVerified !== true || typeof user.email !== "string" ||
      typeof user.providerUserId !== "string" || !user.providerUserId) return null;
    const { getAdminUserStore } = await import("@/lib/admin/admin-user-store");
    const owner = await getAdminUserStore().findByProviderUserId(user.providerUserId);
    return owner?.role === "owner" && owner.status === "active" && owner.emailNormalized === user.email.trim().toLowerCase()
      ? owner.id : null;
  } };
}

export async function requestAdminAccountAction(input: { userId: string; action: AccountAction; idempotencyKey: string }, dependencies: {
  enabled?: () => boolean;
  authorization?: () => Promise<AdminAccountAuthorization>;
  store?: () => AccountLifecycleStore;
  run?: typeof runAccountWriter;
} = {}) {
  if (!(dependencies.enabled ?? isAccountLifecycleEnabled)() || !canonicalUuid(input.userId)) throw new AccountLifecycleError(404, "unavailable");
  const parsed = parseAccountRequest({ action: input.action, idempotencyKey: input.idempotencyKey });
  return (dependencies.run ?? runAccountWriter)("new-work", async () => {
    try {
      const authorization = await (dependencies.authorization ?? loadAdminAccountAuthorization)();
      const selection = currentWriterLifecycleSelection();
      if (selection !== undefined) {
        // Ordinary actor resolution may bind an identity or refresh its
        // sign-in record. Verify the already-bound owner before that work.
        const ownerId = await authorization.readActiveOwnerId();
        if (!canonicalUuid(ownerId)) throw new AccountLifecycleError(403, "account_action_denied");
        requireLifecycleSelection(selection, ["admin", ownerId, input.userId, parsed.action]);
      }
      const actor = await authorization.requireAdminActor();
      if (actor.user.role !== "owner" || actor.user.status !== "active" || actor.developerMode) throw new AccountLifecycleError(403, "account_action_denied");
      requireLifecycleSelection(selection, ["admin", actor.user.id, input.userId, parsed.action]);
      await authorization.requireFreshAdminGoogleAuthentication();
      return (dependencies.store ?? createAccountLifecycleStore)().request({ ...parsed, userId: input.userId, requester: { kind: "admin", adminId: actor.user.id } });
    } catch (error) {
      if (error instanceof AdminAuthenticationFreshnessError) throw new AccountLifecycleError(403, "fresh_sign_in_required");
      if (error instanceof AdminAuthError) throw new AccountLifecycleError(403, "account_action_denied");
      throw error;
    }
  });
}
