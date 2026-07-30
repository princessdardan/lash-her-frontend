import {
  assertAdminPermission,
  type AdminPermissionContext,
} from "./auth-service";
import type { AdminPermissionAction } from "./permissions";
import { AdminAuthError, type AdminActor } from "./types";

export const ADMIN_PERMISSION_DENIAL_AUDIT_EVENT = {
  action: "permission_denied",
  domain: "authorization",
  outcome: "denied",
  reason: "insufficient_permission",
} as const;

export interface AdminPermissionDenial {
  actor: AdminActor;
  requestedPermission: AdminPermissionAction;
}

export async function requirePermissionWithAudit(input: {
  action: AdminPermissionAction;
  context?: AdminPermissionContext;
  getActor: () => Promise<AdminActor>;
  recordDenial: (denial: AdminPermissionDenial) => Promise<void>;
}): Promise<AdminActor> {
  // Identity and active-account failures do not have an authenticated actor
  // and must not be written as permission-denial activity.
  const actor = await input.getActor();

  try {
    assertAdminPermission(actor, input.action, input.context);
  } catch (error) {
    if (error instanceof AdminAuthError && error.code === "forbidden") {
      try {
        await input.recordDenial({
          actor,
          requestedPermission: input.action,
        });
      } catch {
        // Authorization must preserve the original denial if auditing fails.
      }
    }
    throw error;
  }

  return actor;
}
