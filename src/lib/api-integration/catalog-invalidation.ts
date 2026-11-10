import "server-only";

import { revalidatePath, revalidateTag } from "next/cache";

/** A validated authoring receipt is the invalidation point. Catalog handlers
 * retain a 60s shared TTL + 30s stale window if an invalidation cannot propagate. */
export function invalidateCourseCatalog(): void {
  revalidateTag("integration-course-catalog", { expire: 0 });
  revalidatePath("/courses");
  revalidatePath("/courses/[slug]", "page");
  revalidatePath("/api/academy/catalog");
  revalidatePath("/api/academy/catalog/[slug]", "page");
}
