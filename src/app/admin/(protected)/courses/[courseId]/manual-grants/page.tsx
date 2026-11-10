import { ManualAccessWorkspace } from "@/components/admin/course-authoring/manual-access-workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ManualGrantPage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  return <ManualAccessWorkspace courseId={courseId} />;
}
