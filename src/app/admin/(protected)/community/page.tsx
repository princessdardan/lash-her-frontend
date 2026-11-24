import { notFound } from "next/navigation";
import { CommunityModeration } from "@/components/community/community-moderation";
import {
  communityReadsEnabled,
  communityWritesEnabled,
} from "@/lib/api-integration/community-discussions";
import { requirePermission } from "@/lib/admin/auth";
import { AdminAuthError } from "@/lib/admin/types";

export default async function CommunityModerationPage() {
  if (!communityReadsEnabled()) notFound();
  try {
    const actor = await requirePermission("community:moderate");
    if (actor.developerMode) notFound();
  } catch (error) {
    if (error instanceof AdminAuthError) notFound();
    throw error;
  }
  return <CommunityModeration writes={communityWritesEnabled()} />;
}
