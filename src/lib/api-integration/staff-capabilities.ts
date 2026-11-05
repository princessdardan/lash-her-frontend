import "server-only";

import { canAdmin } from "@/lib/admin/permissions";
import type { AdminActor } from "@/lib/admin/types";
import type { CourseCapability } from "./application-jwt";

export function courseCapabilitiesForActor(actor: AdminActor): CourseCapability[] {
  if (actor.user.status !== "active") return [];
  const context = { role: actor.user.role, bookingProviderResourceIds: actor.bookingProviderResourceIds, bookingResourceIds: actor.bookingResourceIds };
  return [...canAdmin({ ...context, action: "courses:edit" }) ? ["course-editor" as const] : [],
    ...canAdmin({ ...context, action: "courses:support" }) ? ["course-support" as const] : []];
}
export function communityCapabilitiesForActor(actor: AdminActor): Array<"community-moderator"> {
  return actor.user.status === "active" && canAdmin({ role: actor.user.role, bookingProviderResourceIds: actor.bookingProviderResourceIds,
    bookingResourceIds: actor.bookingResourceIds, action: "community:moderate" }) ? ["community-moderator"] : [];
}
