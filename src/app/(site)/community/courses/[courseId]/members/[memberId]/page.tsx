import { notFound } from "next/navigation";
import { CommunityMembers } from "@/components/community/community-members";
import { communityMemberHref } from "@/lib/community/client";
import { requireCommunitySession } from "@/lib/community/session";
import { validLearningId } from "@/lib/learning/presentation";

export default async function CommunityMemberPage({
  params,
}: { params: Promise<{ courseId: string; memberId: string }> }) {
  const { courseId, memberId } = await params;
  if (!validLearningId(courseId) || !validLearningId(memberId)) notFound();
  await requireCommunitySession(communityMemberHref(courseId, memberId));
  return <CommunityMembers key={memberId} courseId={courseId} memberId={memberId} />;
}
