import "server-only";

import { redirect } from "next/navigation";
import type { WriterAdmissionRunner } from "@/lib/writer-admission/runtime";
import { runAdminReadOperation } from "./read-operation";
import { AdminAuthError } from "./types";

// The callback includes authorization, workspace reads and every discovery.
// Translate authorization into framework control flow after admission settles.
export async function loadAdmittedCalendarPage<T>(
  load: () => Promise<T>,
  dependencies: {
    run?: WriterAdmissionRunner;
    redirect?: (path: string) => never;
  } = {},
): Promise<T> {
  try {
    return await runAdminReadOperation("calendar-discovery", load, dependencies.run);
  } catch (error) {
    if (!(error instanceof AdminAuthError)) throw error;
    return (dependencies.redirect ?? redirect)(
      error.code === "unauthenticated" ? "/admin/sign-in" : "/admin/not-authorized",
    );
  }
}
