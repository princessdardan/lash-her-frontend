import "server-only";

import { requirePermission } from "@/lib/admin/auth";
import { AdminAuthError } from "@/lib/admin/types";
import { runCourseAdminOperation } from "@/lib/api-integration/course-admin-operation";
import { IntegrationServiceError } from "@/lib/api-integration/service-errors";
import { WriterAdmissionError } from "@/lib/writer-admission/config";

type AuthoringPageData<T> =
  | { kind: "loaded"; data: T }
  | {
      kind: "redirect";
      destination: "/admin/sign-in" | "/admin/not-authorized";
    }
  | { kind: "unavailable"; error: IntegrationServiceError };

// Staff resolution may write identity or a denial audit. Settle the complete
// auth/read operation before a page invokes Next redirect/notFound control flow.
export async function loadCourseAuthoringPage<T>(
  load: () => Promise<T>,
): Promise<AuthoringPageData<T>> {
  try {
    return await runCourseAdminOperation(
      async (): Promise<AuthoringPageData<T>> => {
        try {
          await requirePermission("courses:edit");
          return { kind: "loaded", data: await load() };
        } catch (error) {
          if (error instanceof AdminAuthError)
            return {
              kind: "redirect",
              destination:
                error.code === "unauthenticated"
                  ? "/admin/sign-in"
                  : "/admin/not-authorized",
            };
          if (error instanceof IntegrationServiceError)
            return { kind: "unavailable", error };
          throw error;
        }
      },
    );
  } catch (error) {
    if (!(error instanceof WriterAdmissionError)) throw error;
    return {
      kind: "unavailable",
      error: new IntegrationServiceError("service_unavailable", 503),
    };
  }
}
