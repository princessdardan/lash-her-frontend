import { notFound } from "next/navigation";
import { CommunityView } from "@/components/community/community-view";
import { communityWritesEnabled } from "@/lib/api-integration/community-discussions";
import { communityHref } from "@/lib/community/client";
import { requireCommunitySession } from "@/lib/community/session";
import { validLearningId } from "@/lib/learning/presentation";
import { learningRoutesEnabled } from "@/lib/learning/rollout";

export default async function CommunityCoursePage({
  params,
}: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  if (!validLearningId(courseId)) notFound();
  await requireCommunitySession(communityHref(courseId));
  return (
    <CommunityView
      key={courseId}
      scope={{ courseId }}
      writes={communityWritesEnabled()}
      academyEnabled={learningRoutesEnabled()}
    />
  );
}
