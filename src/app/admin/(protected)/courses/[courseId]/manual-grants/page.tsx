import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/admin/auth";
import { ManualGrantForm } from "@/components/admin/course-authoring/manual-grant-form";
import { getCourseClient } from "@/lib/api-integration/course-client";
import { runCourseAdminOperation } from "@/lib/api-integration/course-admin-operation";
import { isIntegrationFeatureEnabled } from "@/lib/api-integration/rollout-flags";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function ManualGrantPage({ params }: { params: Promise<{ courseId: string }> }) {
  if (!isIntegrationFeatureEnabled("courseReads")) notFound();
  const { courseId } = await params;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(courseId)) notFound();
  const course = await runCourseAdminOperation(async () => {
    const actor = await requirePermission("courses:support");
    if (actor.user.role !== "owner" || actor.user.status !== "active" || actor.developerMode) notFound();
    return (await getCourseClient().getAdminCourse(courseId)).course;
  });
  return <main className="space-y-6 p-6"><h1 className="font-heading text-3xl">Manual access: {course.title}</h1>
    <Link className="underline" href={`/admin/courses/${courseId}`}>Back to course</Link>
    {!(course.status === "published" && course.accessMode === "paid") && <p role="alert">Manual access requires a published paid course. You can still check an existing request below.</p>}
    <ManualGrantForm courseId={courseId} revision={course.revision} eligible={course.status === "published" && course.accessMode === "paid"} />
  </main>;
}
