import "server-only";

import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminAuthError } from "@/lib/admin/types";
import { requirePermission } from "@/lib/admin/auth";
import { ManualGrantForm } from "@/components/admin/course-authoring/manual-grant-form";
import { getCourseClient } from "@/lib/api-integration/course-client";
import { runCourseAdminOperation } from "@/lib/api-integration/course-admin-operation";
import { isIntegrationFeatureEnabled } from "@/lib/api-integration/rollout-flags";
import { IntegrationServiceError } from "@/lib/api-integration/service-errors";
import { WriterAdmissionError } from "@/lib/writer-admission/config";
import { readInteractiveBrowserRequest } from "@/lib/writer-admission/interactive-proof";

async function loadManualGrantCourse(courseId: string) {
  try {
    return await runCourseAdminOperation(async () => {
      try {
        const actor = await requirePermission("courses:support");
        if (actor.user.role !== "owner" || actor.user.status !== "active" || actor.developerMode)
          return { kind: "not-found" } as const;
        return { kind: "loaded", course: (await getCourseClient().getAdminCourse(courseId)).course, actorId: actor.user.id } as const;
      } catch (error) {
        // Authentication may persist an identity or denial audit. Settle known
        // denials/read failures before invoking Next's throwing navigation.
        if (error instanceof AdminAuthError) return { kind: "not-found" } as const;
        if (error instanceof IntegrationServiceError) return { kind: "unavailable", error } as const;
        throw error;
      }
    });
  } catch (error) {
    if (!(error instanceof WriterAdmissionError)) throw error;
    return { kind: "unavailable", error: new IntegrationServiceError("service_unavailable", 503) } as const;
  }
}

export async function ManualAccessWorkspace({ courseId, revoke = false }: { courseId: string; revoke?: boolean }) {
  if (!isIntegrationFeatureEnabled("courseReads")) notFound();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(courseId)) notFound();
  const loaded = await loadManualGrantCourse(courseId);
  if (loaded.kind === "not-found" || loaded.kind === "unavailable" && loaded.error.status === 404) notFound();
  if (loaded.kind === "unavailable") return <main className="space-y-3 p-6">
    <h1 className="font-heading text-3xl">Manual access unavailable</h1>
    <p role="alert">{loaded.error.message}</p>
    <p className="text-xs text-lh-muted">Reference: {loaded.error.requestId}</p>
    <Link className="underline" href="/admin/courses">All courses</Link>
  </main>;
  const { course } = loaded;
  const interactive = await readInteractiveBrowserRequest();
  const selection = revoke ? interactive?.paidRevoke : interactive?.paidGrant;
  const reviewedIdempotencyKey = selection?.actorId === loaded.actorId ? selection.idempotencyKey : undefined;
  const eligible = course.accessMode === "paid" && course.currency === "CAD" && course.priceCents > 0 &&
    (course.status === "published" || revoke && course.status === "archived" && !selection);
  const base = `/admin/courses/${courseId}/manual-grants`;
  return <main className="space-y-6 p-6">
    <h1 className="font-heading text-3xl">{revoke ? "Revoke manual access" : "Manual access"}: {course.title}</h1>
    <nav aria-label="Course access" className="flex flex-wrap gap-4">
      <Link className="underline" href={`/admin/courses/${courseId}`}>Back to course</Link>
      <Link className="underline" prefetch={false} href={revoke ? base : `${base}/revoke`}>
        {revoke ? "Grant manual access" : "Revoke a manual grant"}
      </Link>
    </nav>
    {!eligible && <p role="alert">{revoke
      ? "Revocation requires a published or archived paid course. You can still check an existing request below."
      : "Manual access requires a published paid course. You can still check an existing request below."}</p>}
    <ManualGrantForm courseId={courseId} revision={course.revision} eligible={eligible}
      reviewedIdempotencyKey={reviewedIdempotencyKey} revoke={revoke} />
  </main>;
}
