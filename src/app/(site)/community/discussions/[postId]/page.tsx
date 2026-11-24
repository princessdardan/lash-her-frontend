import { notFound } from "next/navigation";
import { CommunityView } from "@/components/community/community-view";
import {
  communityMediaEnabled,
  communityWritesEnabled,
} from "@/lib/api-integration/community-discussions";
import { discussionHref } from "@/lib/community/client";
import { requireCommunitySession } from "@/lib/community/session";
import { validLearningId } from "@/lib/learning/presentation";
import { learningRoutesEnabled } from "@/lib/learning/rollout";

export default async function CommunityDiscussionPage({
  params,
}: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  if (!validLearningId(postId)) notFound();
  await requireCommunitySession(discussionHref(postId));
  return (
    <CommunityView
      key={postId}
      scope={{ postId }}
      writes={communityWritesEnabled()}
      academyEnabled={learningRoutesEnabled()}
      mediaEnabled={communityMediaEnabled()}
    />
  );
}
