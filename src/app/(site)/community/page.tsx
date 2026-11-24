import { CommunityView } from "@/components/community/community-view";
import { communityWritesEnabled } from "@/lib/api-integration/community-discussions";
import { requireCommunitySession } from "@/lib/community/session";
import { learningRoutesEnabled } from "@/lib/learning/rollout";

export default async function CommunityPage() {
  await requireCommunitySession("/community");
  return (
    <CommunityView
      scope={{}}
      writes={communityWritesEnabled()}
      academyEnabled={learningRoutesEnabled()}
    />
  );
}
