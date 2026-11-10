import "server-only";

import { currentWriterIdentityRotation } from "@/lib/writer-admission/context";
import { withWriterAdmission } from "@/lib/writer-admission/route";
import {
  runWriterAdmission,
  type WriterAdmissionRunner,
} from "@/lib/writer-admission/runtime";

export function withAdminAuthRouteAdmission<R extends Request>(
  handler: (request: R) => Promise<Response>,
  run: WriterAdmissionRunner = runWriterAdmission,
): (request: R) => Promise<Response> {
  const newWork = withWriterAdmission("new-work", handler, run);
  const recovery = withWriterAdmission("recovery", async (request: R) => {
    const response = await handler(request);
    const rotation = currentWriterIdentityRotation();
    if (rotation?.actorKind !== "admin" || new URL(request.url).pathname !== "/api/auth/session" || !response.ok) return response;
    const session = await response.clone().json().catch(() => null);
    // A rejected Auth.js session can carry a cookie cleanup. A different
    // actor's browser state must stay outside the scoped operation.
    return session?.user?.id === rotation.actorId ? response :
      Response.json(null, { status: 403, headers: { "cache-control": "private, no-store" } });
  }, run);
  return (request) => {
    const action = new URL(request.url).pathname.split("/")[3];
    // Existing authorization callbacks, session refresh and sign-out can finish
    // while new sign-ins are closed. Actor bootstrap still has its own gate.
    return ["callback", "session", "signout"].includes(action)
      ? recovery(request)
      : newWork(request);
  };
}
