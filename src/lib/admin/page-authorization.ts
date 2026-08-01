import "server-only";

import { redirect } from "next/navigation";

import {
  requirePermission,
  type AdminPermissionContext,
} from "./auth";
import type { AdminPermissionAction } from "./permissions";
import { AdminAuthError, type AdminActor } from "./types";

export async function requireAdminPagePermission(
  action: AdminPermissionAction,
  context: AdminPermissionContext = {},
): Promise<AdminActor> {
  try {
    return await requirePermission(action, context);
  } catch (error) {
    if (error instanceof AdminAuthError) {
      if (error.code === "unauthenticated") {
        redirect("/admin/sign-in");
      }

      redirect("/admin/not-authorized");
    }

    throw error;
  }
}
