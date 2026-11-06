import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CourseWorkspace } from "@/components/admin/course-authoring/course-workspace";
import { getCourseClient } from "@/lib/api-integration/course-client";
import { isIntegrationFeatureEnabled } from "@/lib/api-integration/rollout-flags";
import { loadCourseAuthoringPage } from "@/lib/course-authoring/page-data";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function CourseAdminPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  if (!isIntegrationFeatureEnabled("courseReads")) notFound();
  const { courseId } = await params;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(courseId))
    notFound();
  const loaded = await loadCourseAuthoringPage(() =>
    getCourseClient().getAdminCourse(courseId),
  );
  if (loaded.kind === "redirect") redirect(loaded.destination);
  if (loaded.kind === "unavailable") {
    const { error } = loaded;
    if (error.status === 404) notFound();
    return (
      <section className="space-y-3">
        <h1 className="font-heading text-4xl uppercase">Course unavailable</h1>
        <p role="alert">{error.message}</p>
        <p className="text-xs text-lh-muted">Reference: {error.requestId}</p>
        <Link href="/admin/courses" className="underline">
          All courses
        </Link>
      </section>
    );
  }
  return <><Link href={`/admin/courses/${courseId}/manual-grants`} className="underline">Owner manual access support</Link><CourseWorkspace initialCourse={loaded.data.course} /></>;
}
