import type { AdminAuditMetadata } from "@/lib/private-db/schema";

import type { AdminActor } from "./types";

export function addAdminActorAuditContext(
  actor: AdminActor,
  metadata: AdminAuditMetadata | undefined,
): AdminAuditMetadata | undefined {
  if (!actor.developerMode) return metadata;

  return {
    ...metadata,
    developerMode: true,
    representedAccountRole: actor.developerMode.accountRole,
    simulatedPermissionRole: actor.developerMode.permissionRole,
  };
}
