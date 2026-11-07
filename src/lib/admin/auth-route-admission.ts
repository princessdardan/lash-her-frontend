import "server-only";

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
  const recovery = withWriterAdmission("recovery", handler, run);
  return (request) => {
    const action = new URL(request.url).pathname.split("/")[3];
    // Existing authorization callbacks, session refresh and sign-out can finish
    // while new sign-ins are closed. Actor bootstrap still has its own gate.
    return ["callback", "session", "signout"].includes(action)
      ? recovery(request)
      : newWork(request);
  };
}
