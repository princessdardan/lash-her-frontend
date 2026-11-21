import "server-only";

import { requirePermission } from "@/lib/admin/auth";
import { AdminAuthError } from "@/lib/admin/types";
import { runCourseAdminReadOperation } from "@/lib/api-integration/course-admin-operation";
import { IntegrationServiceError } from "@/lib/api-integration/service-errors";
import { WriterAdmissionError } from "@/lib/writer-admission/config";

type AuthoringPageData<T> =
  | { kind: "loaded"; data: T }
  | {
      kind: "redirect";
      destination: "/admin/sign-in" | "/admin/not-authorized";
    }
  | { kind: "unavailable"; error: IntegrationServiceError };

function authoringRedirect(error: AdminAuthError): AuthoringPageData<never> {
  return {
    kind: "redirect",
    destination: error.code === "unauthenticated"
      ? "/admin/sign-in"
      : "/admin/not-authorized",
  };
}

// Staff resolution may write identity or a denial audit. Settle the complete
// auth/read operation before a page invokes Next redirect/notFound control flow.
export async function loadCourseAuthoringPage<T>(
  load: () => Promise<T>,
): Promise<AuthoringPageData<T>> {
  const read = async (checkPermission: boolean): Promise<AuthoringPageData<T>> => {
    try {
      if (checkPermission) await requirePermission("courses:edit");
      return { kind: "loaded", data: await load() };
    } catch (error) {
      if (error instanceof AdminAuthError)
        return authoringRedirect(error);
      if (error instanceof IntegrationServiceError)
        return { kind: "unavailable", error };
      throw error;
    }
  };

  try {
    return await runCourseAdminReadOperation(owner => read(!owner));
  } catch (error) {
    if (error instanceof AdminAuthError)
      return authoringRedirect(error);
    if (!(error instanceof WriterAdmissionError)) throw error;
    return {
      kind: "unavailable",
      error: new IntegrationServiceError("service_unavailable", 503),
    };
  }
}
