import { notFound } from "next/navigation";
import { CommunityMembers } from "@/components/community/community-members";
import { communityMembersHref } from "@/lib/community/client";
import { requireCommunitySession } from "@/lib/community/session";
import { validLearningId } from "@/lib/learning/presentation";

export default async function CommunityMembersPage({
  params,
}: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  if (!validLearningId(courseId)) notFound();
  await requireCommunitySession(communityMembersHref(courseId));
  return <CommunityMembers key={courseId} courseId={courseId} />;
}
