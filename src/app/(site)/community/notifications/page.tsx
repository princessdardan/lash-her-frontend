import { CommunityNotifications } from "@/components/community/community-notifications";
import { communityWritesEnabled } from "@/lib/api-integration/community-discussions";
import { requireCommunitySession } from "@/lib/community/session";

export default async function CommunityNotificationsPage() {
  await requireCommunitySession("/community/notifications");
  return <CommunityNotifications writes={communityWritesEnabled()} />;
}
