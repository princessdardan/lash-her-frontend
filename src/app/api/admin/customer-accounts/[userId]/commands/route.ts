import { randomUUID } from "node:crypto";
import { AccountLifecycleError, canonicalUuid, parseAccountRequest } from "@/lib/customer-lifecycle/policy";
import { readAccountJson, requestAdminAccountAction } from "@/lib/customer-lifecycle/handler";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ userId: string }> }) {
  const requestId = randomUUID(), headers = { "cache-control": "private, no-store", "x-request-id": requestId };
  try {
    const origin = new URL(process.env.CUSTOMER_AUTH_URL ?? "").origin;
    if (new URL(request.url).origin !== origin || request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site" || request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") throw new AccountLifecycleError(403, "request_denied");
    const { userId } = await context.params;
    if (!canonicalUuid(userId)) throw new AccountLifecycleError(400, "invalid_request");
    const input = parseAccountRequest(await readAccountJson(request));
    const command = await requestAdminAccountAction({ userId, ...input });
    return Response.json({ commandId: command.commandId, accountVersion: command.accountVersion, action: command.action, status: "pending" }, { status: 202, headers });
  } catch (error) {
    const status = error instanceof AccountLifecycleError ? error.status : 503;
    return Response.json({ error: error instanceof AccountLifecycleError ? error.code : "temporarily_unavailable", requestId }, { status, headers });
  }
}
