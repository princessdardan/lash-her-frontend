import Link from "next/link";
import { notFound } from "next/navigation";
import { CourseWorkspace } from "@/components/admin/course-authoring/course-workspace";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import { getCourseClient } from "@/lib/api-integration/course-client";
import { isIntegrationFeatureEnabled } from "@/lib/api-integration/rollout-flags";
import { IntegrationServiceError } from "@/lib/api-integration/service-errors";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function CourseAdminPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  if (!isIntegrationFeatureEnabled("courseReads")) notFound();
  await requireAdminPagePermission("courses:edit");
  const { courseId } = await params;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(courseId))
    notFound();
  let result;
  try {
    result = await getCourseClient().getAdminCourse(courseId);
  } catch (error) {
    if (!(error instanceof IntegrationServiceError)) throw error;
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
  return <CourseWorkspace initialCourse={result.course} />;
}
